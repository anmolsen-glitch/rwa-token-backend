/**
 *   POST /api/account/kyc/documents         investor uploads (multipart)
 *   GET  /api/account/kyc/documents         their own, metadata
 *   GET  /api/account/kyc/documents/:id     their own, bytes (not audited)
 *
 *   GET  /api/kyc/:accountId/documents      reviewer: metadata
 *   GET  /api/kyc/documents/:id             reviewer: bytes — AUDITED
 *
 * Reviewer routes are platform_admin only. An issuer relies on the platform's
 * verification and receives a decision, never the underlying documents.
 */
import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, Roles, Session, Tenant } from '@shared/auth/decorators';
import type { Principal, TenantContext } from '@shared/auth/tenant-context';
import { AppError } from '@shared/errors/app-error';
import { ApiAuthErrors, ApiNotFound, ApiValidationError } from '@shared/openapi/api-error.decorator';
import { DocumentsService } from './documents.service';

@ApiTags('Investor')
@ApiAuthErrors()
@Session('account')
@Controller('investor/kyc/documents')
export class AccountDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @ApiOperation({
    summary: 'Upload a KYC document',
    description:
      'Multipart. Fields: `file` and `docType`. Bytes go to the storage backend, never ' +
      'into the database row. The filename is recorded but never used to build a path — ' +
      'storage keys are server-generated.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiValidationError()
  @Post()
  async upload(@CurrentUser() principal: Principal, @Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new AppError('NO_FILE', 400, 'Attach a file in the `file` field.');

    /* Read fully into memory: capped at DOCUMENT_MAX_BYTES by the multipart
       plugin, and the hash + encryption both need the whole buffer anyway. */
    const data = await file.toBuffer();
    const docType = (file.fields as Record<string, { value?: string } | undefined>)?.docType?.value;

    return this.documents.upload(principal.id, {
      docType: String(docType ?? ''),
      filename: file.filename,
      mime: file.mimetype,
      data,
    });
  }

  @ApiOperation({ summary: 'List your own uploaded documents (metadata)' })
  @Get()
  listOwn(@CurrentUser() principal: Principal) {
    return this.documents.listOwn(principal.id);
  }

  @ApiOperation({
    summary: 'Download your own document',
    description: 'Not audited as a compliance access — you are reading your own record.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  @ApiNotFound('Document')
  @Get(':id')
  async downloadOwn(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const { data, meta } = await this.documents.download(principal, tenant, id, principal.id);
    return reply
      .header('content-type', meta.mime)
      .header('content-disposition', `inline; filename="${encodeURIComponent(meta.filename)}"`)
      .send(data);
  }
}

@ApiTags('KYC Documents')
@ApiAuthErrors()
@Roles('platform_admin')
@Controller('admin/kyc')
export class ReviewDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @ApiOperation({
    summary: "List a person's documents (reviewer)",
    description: 'Metadata only — no bytes, so no audit row. Fetching a document is audited.',
  })
  @ApiParam({ name: 'accountId', description: 'Account id of the person under review' })
  @Get(':accountId/documents')
  list(@Param('accountId') accountId: string) {
    return this.documents.listFor(accountId);
  }

  @ApiOperation({
    summary: 'Download a document for review — AUDITED',
    description:
      'Writes a `kyc.document_read` audit row: who looked, at whose document, when. ' +
      'platform_admin only: issuers rely on the platform\'s verification and receive a ' +
      'decision, not the underlying identity documents.',
  })
  @ApiParam({ name: 'id', description: 'Document id' })
  @ApiNotFound('Document')
  @Get('documents/:id')
  async download(
    @CurrentUser() principal: Principal,
    @Tenant() tenant: TenantContext,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const { data, meta } = await this.documents.download(principal, tenant, id);
    return reply
      .header('content-type', meta.mime)
      /* attachment, not inline: a reviewed passport should not render inside
         an admin page where a stray screenshot leaks it. */
      .header('content-disposition', `attachment; filename="${encodeURIComponent(meta.filename)}"`)
      .send(data);
  }
}
