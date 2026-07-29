/**
 * PDF rendering through headless Chromium, and the normalisation pass that makes its
 * output byte-stable.
 *
 * Chromium writes a `/CreationDate`, a `/ModDate`, and a document `/ID` into every
 * PDF it produces. All three vary run to run, which would defeat "reissuing a
 * historical document is byte-identical" before the first invoice was ever reprinted.
 *
 * `normalisePdf` rewrites them **in place, preserving byte length**, so the file's
 * cross-reference offsets stay valid:
 *   - dates become a fixed epoch, formatted exactly as Chromium formats them;
 *   - the /ID pair is replaced with a hash of the document's own bytes, which makes
 *     it a content identifier rather than a run identifier.
 *
 * If a match is not the expected length it is left alone, because a corrupted PDF is
 * worse than a byte-unstable one — and the assertion in the test suite would catch it.
 */
import { createHash } from 'node:crypto'
import { PdfEngineUnavailableError } from './errors.js'
import type { PageSize } from './types.js'

const CANONICAL_DATE = "D:19700101000000+00'00'"

export interface PdfOptions {
  readonly pageSize: PageSize
  readonly margin: string
}

interface PlaywrightLike {
  chromium: {
    launch(options?: {
      args?: string[]
      headless?: boolean
    }): Promise<{
      newPage(): Promise<{
        emulateMedia(options: { media: 'print' | 'screen' }): Promise<void>
        setContent(html: string, options?: { waitUntil?: string }): Promise<void>
        pdf(options?: Record<string, unknown>): Promise<Buffer>
        close(): Promise<void>
      }>
      close(): Promise<void>
    }>
  }
}

type Browser = Awaited<ReturnType<PlaywrightLike['chromium']['launch']>>

let browser: Browser | null = null

async function launch(): Promise<Browser> {
  if (browser !== null) return browser
  let playwright: PlaywrightLike
  try {
    playwright = (await import('playwright')) as unknown as PlaywrightLike
  } catch (cause) {
    throw new PdfEngineUnavailableError(`playwright is not installed (${String(cause)})`)
  }
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        // Rendering flags that remove run-to-run variation. They do not make two
        // *different* Chromium builds agree — the catalog snapshot pins the browser
        // version for the same reason it pins Prettier (ARCHITECTURE.md section 10) —
        // but with one build they make the output stable.
        '--font-render-hinting=none',
        '--disable-lcd-text',
        '--force-color-profile=srgb',
        '--hide-scrollbars',
        '--disable-dev-shm-usage',
      ],
    })
  } catch (cause) {
    throw new PdfEngineUnavailableError(String(cause))
  }
  return browser
}

/** Shuts the shared browser down. Tests and worker shutdown call this. */
export async function closePdfEngine(): Promise<void> {
  if (browser !== null) {
    await browser.close()
    browser = null
  }
}

export async function htmlToPdf(html: string, opts: PdfOptions): Promise<Buffer> {
  const instance = await launch()
  const page = await instance.newPage()
  try {
    await page.emulateMedia({ media: 'print' })
    // 'load' rather than 'networkidle': the token stylesheet may be a same-origin
    // path with no server behind it in a worker, and waiting for it would hang.
    await page.setContent(html, { waitUntil: 'load' })
    const buffer = await page.pdf({
      printBackground: true,
      // The shell's @page rule owns the size, so one place decides it.
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: opts.margin, right: opts.margin, bottom: opts.margin, left: opts.margin },
      tagged: false,
      outline: false,
    })
    return normalisePdf(buffer)
  } finally {
    await page.close()
  }
}

/** Rewrites the run-varying fields. Length-preserving, so xref offsets stay valid. */
export function normalisePdf(input: Uint8Array): Buffer {
  let text = Buffer.from(input).toString('latin1')

  text = text.replace(
    /\/(CreationDate|ModDate)\s*\((D:[^)]*)\)/g,
    (match, field: string, value: string) =>
      value.length === CANONICAL_DATE.length ? `/${field} (${CANONICAL_DATE})` : match,
  )

  const idPattern = /\/ID\s*\[\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\]/g
  const blanked = text.replace(idPattern, (match) => '0'.repeat(match.length))
  const digest = createHash('sha256').update(Buffer.from(blanked, 'latin1')).digest('hex')

  text = text.replace(idPattern, (match, first: string, second: string) => {
    if (first.length !== second.length || first.length > digest.length) return match
    const id = digest.slice(0, first.length).toUpperCase()
    return match.replace(`<${first}>`, `<${id}>`).replace(`<${second}>`, `<${id}>`)
  })

  return Buffer.from(text, 'latin1')
}

/** True when the bytes look like a PDF at all. Used by the smoke test. */
export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
}
