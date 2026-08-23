import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DbService } from '@shared/db/db.service';
import { kycDocuments, type KycDocument } from '@shared/db/schema';

/**
 * Uses db.worker(): documents belong to a PERSON who, during KYC, has joined no
 * issuer's cap table. Authorization is the session type plus @Roles, and every
 * read of the bytes is audited by the service.
 */
@Injectable()
export class DocumentsRepository {
  constructor(private readonly db: DbService) {}

  listForAccount(accountId: string): Promise<KycDocument[]> {
    return this.db.worker('documents: list for account', (tx) =>
      tx
        .select()
        .from(kycDocuments)
        .where(eq(kycDocuments.accountId, accountId))
        .orderBy(desc(kycDocuments.uploadedAt)),
    );
  }

  async byId(id: string): Promise<KycDocument | undefined> {
    const [row] = await this.db.worker('documents: load by id', (tx) =>
      tx.select().from(kycDocuments).where(eq(kycDocuments.id, id)).limit(1),
    );
    return row;
  }

  async insert(doc: {
    accountId: string;
    docType: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    storageBackend: string;
    storageKey: string;
    sha256: string;
    encrypted: boolean;
  }): Promise<KycDocument> {
    const [row] = await this.db.worker('documents: insert', (tx) =>
      tx.insert(kycDocuments).values({ ...doc, content: null }).returning(),
    );
    return row;
  }
}
