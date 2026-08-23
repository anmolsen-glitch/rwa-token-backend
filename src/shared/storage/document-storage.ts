/**
 * Storage seam — same shape as the mailer / payment / KYC seams.
 *
 * Callers put and get bytes by an opaque key and never learn where they live.
 * Production is local disk on EC2 today; S3 or a managed store later is a new
 * implementation of this interface, not a change at any call site.
 */
export interface StoredObject {
  key: string;
  sha256: string;
  sizeBytes: number;
  encrypted: boolean;
}

export interface DocumentStorage {
  readonly name: string;
  /** Store bytes and return the key needed to read them back. */
  put(data: Buffer, hint: { accountId: string; filename: string }): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Injection token — see storage.module.ts. */
export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');
