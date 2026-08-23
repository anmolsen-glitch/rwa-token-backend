/**
 * Local-disk document storage — the EC2 deployment target.
 *
 * DESIGN NOTES, because identity documents are the most sensitive bytes this
 * system handles:
 *
 * - ENCRYPTED AT REST with AES-256-GCM. A stolen EBS snapshot or a misplaced
 *   backup is otherwise a pile of readable passports. GCM is authenticated, so
 *   tampering fails to decrypt rather than returning altered bytes.
 * - KEYS ARE OPAQUE AND SERVER-GENERATED. The user's filename never touches the
 *   path, which removes path traversal as a category rather than sanitising for
 *   it. The original name is kept in the database column instead.
 * - FILES ARE NEVER SERVED STATICALLY. There is no public route to the storage
 *   root; every read goes through an authenticated, audited endpoint.
 * - 0700 directories, 0600 files: readable only by the process user.
 *
 * OPERATIONAL LIMITS, stated plainly:
 * - Local disk is tied to ONE instance. A second app server cannot read what
 *   the first wrote. Use one instance, or switch this implementation to S3/EFS
 *   before scaling out.
 * - These files are NOT in the Postgres backup. They need their own EBS
 *   snapshot schedule, or a KYC document survives a database restore only as a
 *   row pointing at a missing file.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DocumentStorage, StoredObject } from './document-storage';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

@Injectable()
export class LocalDiskStorage implements DocumentStorage {
  readonly name = 'local-disk';
  private readonly logger = new Logger(LocalDiskStorage.name);

  constructor(
    private readonly root: string,
    /** 32-byte key, or null to store plaintext (refused in production). */
    private readonly key: Buffer | null,
  ) {}

  /**
   * Opaque key: <accountId>/<random>. Sharding by account keeps directories
   * small and makes "delete everything for this person" a directory removal,
   * which matters for erasure requests.
   */
  private static newKey(accountId: string): string {
    return `${accountId}/${randomBytes(16).toString('hex')}`;
  }

  /** Resolve inside the root, and refuse anything that escapes it. */
  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(resolve(this.root) + '/')) {
      /* Unreachable with server-generated keys — this is the backstop for the
         day someone passes a key in from a request. */
      throw new Error('Refusing a storage key that escapes the storage root');
    }
    return full;
  }

  async put(data: Buffer, hint: { accountId: string; filename: string }): Promise<StoredObject> {
    const key = LocalDiskStorage.newKey(hint.accountId);
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    /* Hash the PLAINTEXT: integrity is a property of the document, and it must
       still verify after a key rotation re-encrypts the file. */
    const sha256 = createHash('sha256').update(data).digest('hex');
    const payload = this.key ? this.encrypt(data) : data;

    await writeFile(path, payload, { mode: 0o600 });
    return { key, sha256, sizeBytes: data.length, encrypted: Boolean(this.key) };
  }

  async get(key: string): Promise<Buffer> {
    const raw = await readFile(this.pathFor(key));
    return this.key ? this.decrypt(raw) : raw;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (err) {
      /* Already gone is the desired end state. */
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.logger.warn(`delete: ${key} was already absent`);
    }
  }

  /** Layout: iv | authTag | ciphertext. */
  private encrypt(data: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key!, iv);
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private decrypt(blob: Buffer): Buffer {
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = blob.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this.key!, iv);
    decipher.setAuthTag(tag);
    /* Throws if the file was altered — GCM authenticates, so a corrupted or
       tampered document fails loudly instead of returning wrong bytes. */
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  static resolveRoot(root: string): string {
    return resolve(root);
  }

  static join = join;
}
