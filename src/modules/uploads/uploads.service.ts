/**
 * Image upload storage — the same provider-seam idea as payments/KYC/AML. Dev
 * and the EC2 target write to a local directory served back at
 * GET /api/uploads/:file; a real scale-out swaps this for S3 + a CDN URL.
 *
 * Images arrive as base64 data URLs (no multipart dependency, and consistent
 * with how the portals already send them). Filenames are random hex — never
 * derived from client input, so traversal is removed as a category rather
 * than sanitised for. The serve path enforces the same alphabet on the way
 * back out.
 *
 * Unauthenticated by design: a public seller uploads an image before applying.
 * Guarded by a per-route rate limit and size/type caps (see main.ts).
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '@shared/config/app-config.service';
import { AppError } from '@shared/errors/app-error';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/* Exactly what save() generates: 16 random bytes as hex + a known extension. */
const STORED_NAME = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/;

@Injectable()
export class UploadsService {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly baseUrl: string;

  constructor(config: AppConfig) {
    this.dir = path.resolve(config.get('UPLOADS_DIR'));
    this.maxBytes = config.get('UPLOAD_MAX_BYTES');
    this.baseUrl = config.get('PUBLIC_BASE_URL');
  }

  /** Persist a base64 image data URL; return its absolute served URL. */
  async save(dataUrl: unknown): Promise<{ url: string }> {
    if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
      throw new AppError('NO_IMAGE', 400, 'No image provided.');
    }
    const m = /^data:([a-z0-9/+.-]+);base64,(.*)$/is.exec(dataUrl.trim());
    if (!m) {
      throw new AppError('INVALID_DATA_URL', 400, 'Expected a base64 image data URL.');
    }
    const ext = EXT_BY_MIME[m[1].toLowerCase()];
    if (!ext) {
      throw new AppError(
        'UNSUPPORTED_IMAGE_TYPE',
        415,
        'Unsupported image type. Use PNG, JPEG, WebP, or GIF.',
      );
    }
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length === 0) throw new AppError('EMPTY_IMAGE', 400, 'Image is empty.');
    if (buf.length > this.maxBytes) {
      const maxMb = Math.round(this.maxBytes / (1024 * 1024));
      throw new AppError('IMAGE_TOO_LARGE', 413, `Image is too large (max ${maxMb} MB).`);
    }
    await fs.mkdir(this.dir, { recursive: true });
    const name = `${randomBytes(16).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(this.dir, name), buf);
    return { url: `${this.baseUrl}/api/uploads/${name}` };
  }

  /** Read a stored image back. The name must match what save() generates. */
  async read(file: string): Promise<{ data: Buffer; mime: string }> {
    const m = STORED_NAME.exec(file);
    if (!m) throw new AppError('UPLOAD_NOT_FOUND', 404, 'No such image.');
    try {
      const data = await fs.readFile(path.join(this.dir, file));
      return { data, mime: MIME_BY_EXT[m[1]] };
    } catch {
      throw new AppError('UPLOAD_NOT_FOUND', 404, 'No such image.');
    }
  }
}
