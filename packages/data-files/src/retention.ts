/**
 * The retention sweep, and the reaping of abandoned upload grants.
 *
 * Two different things, deliberately in one job:
 *
 *  - **Reaping** is the capability's own housekeeping. An upload grant that expired
 *    without being confirmed leaves a File row in `awaiting_upload` and possibly a
 *    partial object; both go, because "no orphaned objects" has to hold for uploads
 *    that were abandoned as well as for entities that were deleted.
 *  - **Retention** is the client's policy, and the capability ships none. Deleting a
 *    client's files on a guess is not a sensible default, so nothing is deleted until
 *    the `retentionRules` slot says so.
 */
import { files } from './config.js'
import { deleteFile } from './cascade.js'
import { hardDelete, repositories } from './repositories.js'
import { RETENTION_JOB_KIND } from './scanning.js'

const DAY_MS = 86_400_000

export interface RetentionSweepResult {
  readonly examined: number
  readonly deleted: number
  readonly sessionsReaped: number
}

export async function runRetentionSweep(
  payload: { now?: string } = {},
): Promise<RetentionSweepResult> {
  const cfg = files()
  const repos = await repositories()
  const now = payload.now === undefined ? new Date() : new Date(payload.now)

  // 1. Abandoned grants.
  let sessionsReaped = 0
  for (const session of await repos.sessions.findMany()) {
    if (session.completedAt !== null || session.expiresAt.getTime() > now.getTime()) continue
    const file = await repos.files.find(session.fileId)
    if (file !== null && file.status === 'awaiting_upload') {
      // Removes the row and anything the client managed to upload before giving up.
      await deleteFile(file.id, { cascadeSource: 'retention:expired_upload_session' })
    } else {
      await hardDelete(repos.sessions, session.id)
    }
    sessionsReaped += 1
  }

  // 2. Client retention policy.
  const rules = cfg.slots.retentionRules
  if (rules === undefined) return { examined: 0, deleted: 0, sessionsReaped }

  const candidates = await repos.files.findMany()
  let deleted = 0
  for (const file of candidates) {
    if (file.status === 'deleted') continue
    const decision = await rules({
      file,
      now,
      ageDays: (now.getTime() - file.createdAt.getTime()) / DAY_MS,
    })
    if (decision.action === 'delete') {
      await deleteFile(file.id, { cascadeSource: `retention:${decision.reason}` })
      deleted += 1
    }
  }
  return { examined: candidates.length, deleted, sessionsReaped }
}

/**
 * Registered by the worker, not at configure time: scheduling is a side effect and
 * the web process boots the same config file.
 */
export async function scheduleRetentionSweep(cron = '0 3 * * *'): Promise<void> {
  const repos = await repositories()
  await repos.schedule(cron, { kind: RETENTION_JOB_KIND, payload: {} })
}
