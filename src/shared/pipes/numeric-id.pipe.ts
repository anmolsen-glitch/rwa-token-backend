/**
 * Validates a bigint-keyed `:id` path parameter.
 *
 * Without this, `/api/admin/managers/abc` reaches Postgres and dies with
 * `invalid input syntax for type bigint`, which the filter has no choice but to
 * report as a 500. That is wrong twice over: the caller's request was bad, not
 * ours, and a 500 on a malformed id is a cheap way for someone to tell which
 * routes are backed by a bigint column and which by a text one.
 *
 * A 404 (not a 400) is the honest answer: no such resource can exist under that
 * id, and it matches what a well-formed but unknown id returns — so probing
 * cannot distinguish "wrong shape" from "not yours".
 */
import { Injectable, PipeTransform } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';

@Injectable()
export class NumericIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^\d{1,19}$/.test(value)) {
      throw AppError.notFound('Resource', value);
    }
    return value;
  }
}
