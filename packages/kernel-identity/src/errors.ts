/** Errors this capability raises, each carrying the HTTP status the route layer uses. */
export class IdentityError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
    this.status = status
  }
}

export class EmailInUseError extends IdentityError {
  constructor(email: string) {
    super('email_in_use', `An account already exists for ${email}.`, 409)
  }
}

export class InvalidCredentialsError extends IdentityError {
  constructor() {
    // Deliberately identical for "no such user" and "wrong password" so the
    // response cannot be used to enumerate accounts.
    super('invalid_credentials', 'Email or password is incorrect.', 401)
  }
}

export class EmailNotVerifiedError extends IdentityError {
  constructor() {
    super('email_not_verified', 'Verify your email address before signing in.', 403)
  }
}

export class AccountDisabledError extends IdentityError {
  constructor() {
    super('account_disabled', 'This account has been disabled.', 403)
  }
}

export class InvalidTokenError extends IdentityError {
  constructor(what: string) {
    super('invalid_token', `This ${what} link is invalid, expired, or already used.`, 400)
  }
}

export class PasswordRejectedError extends IdentityError {
  constructor(reason: string) {
    super('password_rejected', reason, 422)
  }
}

export class NotAuthenticatedError extends IdentityError {
  constructor() {
    super('not_authenticated', 'Authentication required.', 401)
  }
}

export class UserNotFoundError extends IdentityError {
  constructor(id: string) {
    super('user_not_found', `No user with id ${id}.`, 404)
  }
}
