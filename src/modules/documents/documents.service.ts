/**
 * KYC document upload and retrieval.
 *
 * These are the most sensitive bytes in the system — passports, driving
 * licences, utility bills. Three rules follow from that:
 *
 *   1. Bytes live in the storage backend, never in the database row.
 *   2. Every retrieval of the BYTES is audited (TENANCY_MODEL.md §5.2).
 *      Listing metadata is not, or the trail fills with noise and hides the
 *      reads that matter.
 *   3. Only the platform reads them. An issuer relies on the platform's
 *      verification (§D2) and receives a decision, not the underlying
 *      documents — that is the whole point of verify-once/accept-per-issuer.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { AuditService } from '@shared/audit/audit.service';
import { AppConfig } from '@shared/config/app-config.service';
import { DOCUMENT_STORAGE, type DocumentStorage } from '@shared/storage/document-storage';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import type { KycDocument } from '@shared/db/schema';
import { KycRepository } from '@modules/kyc/kyc.repository';
import { DocumentsRepository } from './documents.repository';

/** What a document may be. Free-form types would make review unauditable. */
export const DOC_TYPES = [
  'passport',
  'drivers_license',
  'national_id',
  'pan',
  'address:utility_bill',
  'address:bank_statement',
  'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Only formats a reviewer can actually open. */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export interface DocumentMeta {
  id: string;
  docType: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
  encrypted: boolean;
  uploadedAt: string;
  /** Legacy rows still hold base64 in Postgres (pre-migration-046). */
  storedInDatabase: boolean;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
    private readonly kyc: KycRepository,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  private static meta(d: KycDocument): DocumentMeta {
    return {
      id: d.id,
      docType: d.docType,
      filename: d.filename,
      mime: d.mime,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
      encrypted: d.encrypted,
      uploadedAt: d.uploadedAt.toISOString(),
      storedInDatabase: d.storageKey === null,
    };
  }

  /**
   * Upload, by the person themselves (account session).
   *
   * `filename` is recorded but NEVER used to build a path — the storage key is
   * server-generated, which removes path traversal as a category rather than
   * sanitising for it.
   */
  async upload(
    accountId: string,
    input: { docType: string; filename: string; mime: string; data: Buffer },
  ): Promise<DocumentMeta> {
    if (!DOC_TYPES.includes(input.docType as DocType)) {
      throw new AppError('INVALID_DOC_TYPE', 400, `docType must be one of ${DOC_TYPES.join(', ')}.`);
    }
    if (!ALLOWED_MIME.has(input.mime)) {
      throw new AppError(
        'UNSUPPORTED_FILE_TYPE',
        400,
        'Upload a JPEG, PNG, WebP, or PDF.',
        { received: input.mime },
      );
    }
    if (input.data.length === 0) {
      throw new AppError('EMPTY_FILE', 400, 'The uploaded file is empty.');
    }

    /* Re-checked here even though the multipart plugin caps it: that limit
       protects the process, this one is the business rule. */
    const max = this.config.get('DOCUMENT_MAX_BYTES');
    if (input.data.length > max) {
      throw new AppError('FILE_TOO_LARGE', 413, `Maximum file size is ${max} bytes.`, {
        sizeBytes: input.data.length,
      });
    }

    const stored = await this.storage.put(input.data, {
      accountId,
      filename: input.filename,
    });

    const row = await this.repo.insert({
      accountId,
      docType: input.docType,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: stored.sizeBytes,
      storageBackend: this.storage.name,
      storageKey: stored.key,
      sha256: stored.sha256,
      encrypted: stored.encrypted,
    });

    return DocumentsService.meta(row);
  }

  /** The person's own documents. Metadata only — no audit row. */
  async listOwn(accountId: string): Promise<{ items: DocumentMeta[] }> {
    const rows = await this.repo.listForAccount(accountId);
    return { items: rows.map(DocumentsService.meta) };
  }

  /** A reviewer listing someone's documents. Metadata only — no bytes, no audit. */
  async listFor(subject: string): Promise<{ items: DocumentMeta[] }> {
    /* The reviewer UI addresses people by WALLET; accept either, same as the
       KYC decision routes' :subject. */
    const account = await this.kyc.resolveSubject(subject);
    if (!account) return { items: [] };
    const rows = await this.repo.listForAccount(account.id);
    return { items: rows.map(DocumentsService.meta) };
  }

  /**
   * Fetch the actual bytes. THE audited path.
   *
   * `self` is the account id when the person is fetching their own document —
   * that is not a compliance access and is not audited as one, or the trail
   * fills with people looking at their own passport.
   */
  async download(
    principal: Principal,
    tenant: TenantContext,
    id: string,
    self?: string,
  ): Promise<{ data: Buffer; meta: DocumentMeta }> {
    const doc = await this.repo.byId(id);
    if (!doc) throw AppError.notFound('Document', id);

    if (self !== undefined && doc.accountId !== self) {
      /* 404, not 403: confirming the id exists would leak that the platform
         holds a document for someone else. */
      throw AppError.notFound('Document', id);
    }

    let data: Buffer;
    if (doc.storageKey) {
      data = await this.storage.get(doc.storageKey);
    } else if (doc.content) {
      /* Legacy row, still base64 in Postgres. */
      data = Buffer.from(doc.content, 'base64');
    } else {
      /* The CHECK constraint makes this unreachable; if it fires, a row lost
         its bytes and that is a data-integrity incident, not a 404. */
      throw new AppError('DOCUMENT_UNRETRIEVABLE', 500, 'Document has no stored content.');
    }

    if (self === undefined) {
      await this.audit.record(principal, tenant, {
        action: 'kyc.document_read',
        target: doc.accountId ?? doc.wallet ?? id,
        params: { documentId: id, docType: doc.docType, filename: doc.filename },
      });
    }

    return { data, meta: DocumentsService.meta(doc) };
  }
}
