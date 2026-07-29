/**
 * Retention sweep. The capability ships no policy of its own — deleting a client's
 * files on a guess is not a default anyone wants — so the sweep does nothing until
 * the `retentionRules` slot is implemented.
 */
import { files } from './config.js'
import { deleteFile } from './cascade.js'
import { repositories } from './repositories.js'
import { RETENTION_JOB_KIND } from './scanning.js'

const DAY_MS = 86_400_000

export interface RetentionSweepResult {
  readonly examined: number
  readonly deleted: number
}

export async function runRetentionSweep(
  payload: { now?: string } = {},
): Promise<RetentionSweepResult> {
  const cfg = files()
  const rules = cfg.slots.retentionRules
  if (rules === undefined) return { examined: 0, deleted: 0 }

  const repos = await repositories()
  const now = payload.now === undefined ? new Date() : new Date(payload.now)
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
  return { examined: candidates.length, deleted }
}

/**
 * Registered by the worker, not at configure time: scheduling is a side effect and
 * the web process boots the same config file.
 */
export async function scheduleRetentionSweep(cron = '0 3 * * *'): Promise<void> {
  const repos = await repositories()
  await repos.schedule(cron, { kind: RETENTION_JOB_KIND, payload: {} })
}
