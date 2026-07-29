/**
 * Errors carry an HTTP status because the route layer maps them straight onto a
 * response, and because one of them is load-bearing: a file that has not cleared
 * scanning must be indistinguishable from a file that does not exist. It is a 404,
 * never a 403 — a 403 tells an attacker the object is there.
 */
export class FilesError extends Error {
  readonly status: number
  readonly code: string

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'FilesError'
    this.code = code
    this.status = status
  }
}

export class FileNotFoundError extends FilesError {
  constructor(id: string) {
    super('file_not_found', `No file ${id}`, 404)
    this.name = 'FileNotFoundError'
  }
}

/**
 * Thrown for a file that exists but has not cleared scanning, or is quarantined,
 * or is deleted. Deliberately a 404 with the same code as a genuine miss.
 */
export class FileNotAccessibleError extends FilesError {
  constructor(id: string) {
    super('file_not_found', `No file ${id}`, 404)
    this.name = 'FileNotAccessibleError'
  }
}

export class UploadRejectedError extends FilesError {
  constructor(reason: string) {
    super('upload_rejected', reason, 422)
    this.name = 'UploadRejectedError'
  }
}

export class SignatureInvalidError extends FilesError {
  constructor(reason: string) {
    super('signature_invalid', reason, 403)
    this.name = 'SignatureInvalidError'
  }
}

/** The signed URL was well-formed but past its TTL. Storage rejects it. */
export class SignatureExpiredError extends FilesError {
  constructor() {
    super('signature_expired', 'Signed URL has expired', 403)
    this.name = 'SignatureExpiredError'
  }
}

/**
 * The scanner could not be reached. Under `require_clean` this propagates so the
 * durable queue retries; under `reject_when_unavailable` the file is quarantined.
 */
export class ScannerUnavailableError extends FilesError {
  constructor(detail: string) {
    super('scanner_unavailable', `Virus scanner unavailable: ${detail}`, 503)
    this.name = 'ScannerUnavailableError'
  }
}

export class FilesConfigError extends FilesError {
  constructor(message: string) {
    super('files_config_error', message, 500)
    this.name = 'FilesConfigError'
  }
}
