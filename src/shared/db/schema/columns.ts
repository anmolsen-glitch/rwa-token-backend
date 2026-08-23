/**
 * Shared column types.
 *
 * Postgres BIGINT / BIGSERIAL exceeds what a JS `number` can represent safely
 * (2^53). Drizzle's built-in `bigserial` only offers `number` or `bigint` modes,
 * neither of which we want at the API edge: `number` silently loses precision
 * and `bigint` does not survive JSON.stringify.
 *
 * So IDs are strings in TypeScript, everywhere, with the conversion declared
 * exactly once here. node-postgres already returns int8 as a string, so this is
 * close to an identity mapping — it just makes the type honest.
 */
import { customType } from 'drizzle-orm/pg-core';

export const bigintId = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'bigint';
  },
  fromDriver(value: string): string {
    return String(value);
  },
  toDriver(value: string): string {
    return value;
  },
});
