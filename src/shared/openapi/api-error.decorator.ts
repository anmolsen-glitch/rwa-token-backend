/**
 * Shared OpenAPI decorators.
 *
 * Documentation is part of the unipattern (CLAUDE.md §5): every endpoint
 * describes its errors the same way, using the SAME error envelope the
 * AppExceptionFilter actually produces. Hand-writing `@ApiResponse` per route
 * is how docs drift from behaviour.
 */
import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/** Mirrors the one error shape from AppExceptionFilter. */
export const ERROR_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable, machine-readable identifier. Clients may branch on this.',
          example: 'FORBIDDEN',
        },
        message: {
          type: 'string',
          description: 'Human-readable. May change without notice — do not branch on it.',
        },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

const err = (status: number, description: string, code: string) =>
  ApiResponse({
    status,
    description,
    schema: {
      ...ERROR_SCHEMA,
      example: { error: { code, message: description } },
    },
  });

/**
 * Errors every authenticated route can return.
 *
 * Guards are global and fail closed, so 401/403 are reachable on every route
 * that is not @Public() — documenting them per-route by hand would be both
 * repetitive and easy to forget.
 */
export const ApiAuthErrors = () =>
  applyDecorators(
    ApiCookieAuth('session'),
    ApiBearerAuth('bearer'),
    err(401, 'Missing, invalid, or expired credentials.', 'UNAUTHORIZED'),
    err(403, 'Authenticated, but not permitted to perform this action.', 'FORBIDDEN'),
  );

export const ApiValidationError = () =>
  err(400, 'Request body or query failed validation.', 'VALIDATION_FAILED');

export const ApiNotFound = (what = 'Resource') =>
  err(
    404,
    `${what} not found — or it exists but belongs to another tenant. The two are ` +
      `deliberately indistinguishable, since confirming existence would itself leak.`,
    'NOT_FOUND',
  );

export const ApiConflict = (description: string, code = 'CONFLICT') =>
  err(409, description, code);

export const ApiUnprocessable = (description: string, code = 'UNPROCESSABLE') =>
  err(422, description, code);

export const ApiRateLimited = () =>
  err(429, 'Too many requests. Retry after the indicated window.', 'TOO_MANY_ATTEMPTS');
