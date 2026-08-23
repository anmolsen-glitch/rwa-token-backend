/**
 * The one error type services throw.
 *
 * `code` is a stable, machine-readable identifier that clients may branch on —
 * it is part of the API contract and must not change once shipped.
 * `message` is for humans and may be reworded freely.
 *
 * Services throw AppError for *expected* failures (not found, forbidden by
 * policy, conflicting state). Anything else that escapes becomes a 500 with no
 * detail leaked — see AppExceptionFilter.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(resource: string, id?: string) {
    return new AppError('NOT_FOUND', 404, `${resource} not found.`, id ? { id } : undefined);
  }

  static forbidden(message = 'You do not have permission to perform this action.') {
    return new AppError('FORBIDDEN', 403, message);
  }

  static unauthorized(message = 'Missing or invalid credentials.') {
    return new AppError('UNAUTHORIZED', 401, message);
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>) {
    return new AppError(code, 409, message, details);
  }

  /** Business rule violated — the request was well-formed but not permitted. */
  static unprocessable(code: string, message: string, details?: Record<string, unknown>) {
    return new AppError(code, 422, message, details);
  }
}
