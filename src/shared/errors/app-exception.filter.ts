/**
 * The single exception filter. Every error leaves the API in this shape:
 *
 *   { "error": { "code": "OFFERING_NOT_FOUND", "message": "…", "details": {} } }
 *
 * Registered globally in main.ts, so no controller ever writes a try/catch to
 * shape an error response.
 *
 * Security: unexpected errors are logged in full but returned as a bare 500.
 * Driver messages and stack traces never reach a client — a Postgres error can
 * disclose table and column names.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';
import { AppError } from './app-error';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface ZodIssueLike {
  path: ReadonlyArray<string | number>;
  message: string;
}

/** Structural narrowing — works across Zod 3 and 4 issue shapes. */
function toIssues(error: unknown): Array<{ path: string; message: string }> {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('issues' in error) ||
    !Array.isArray((error as { issues: unknown }).issues)
  ) {
    return [];
  }
  return (error as { issues: ZodIssueLike[] }).issues.map((i) => ({
    path: Array.isArray(i.path) ? i.path.join('.') : '',
    message: String(i.message),
  }));
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const { status, body } = this.toResponse(exception);

    if (status >= 500) {
      this.logger.error(
        { err: exception },
        exception instanceof Error ? exception.message : 'Unhandled exception',
      );
    }

    void reply.status(status).send(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: {
          error: { code: exception.code, message: exception.message, details: exception.details },
        },
      };
    }

    /* Zod pipe rejections — surface which fields failed, nothing more.
       getZodError() is `unknown` in nestjs-zod v5 (it supports both Zod 3 and
       4), so narrow structurally rather than casting blindly. */
    if (exception instanceof ZodValidationException) {
      return {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request failed validation.',
            details: { issues: toIssues(exception.getZodError()) },
          },
        },
      };
    }

    /* Nest's own exceptions (404 from the router, payload-too-large, …). */
    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        body: {
          error: {
            code: this.codeFromStatus(exception.getStatus()),
            message: exception.message,
          },
        },
      };
    }

    return {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } },
    };
  }

  private codeFromStatus(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      422: 'UNPROCESSABLE',
      429: 'RATE_LIMITED',
    };
    return map[status] ?? 'ERROR';
  }
}
