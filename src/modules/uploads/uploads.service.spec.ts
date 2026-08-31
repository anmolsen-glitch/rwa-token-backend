import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '@shared/config/app-config.service';
import { AppError } from '@shared/errors/app-error';
import { UploadsService } from './uploads.service';

const dir = mkdtempSync(join(tmpdir(), 'uploads-spec-'));

const config = {
  get: (key: string) =>
    ({
      UPLOADS_DIR: dir,
      UPLOAD_MAX_BYTES: 1024,
      PUBLIC_BASE_URL: 'http://front-door',
    })[key],
} as unknown as AppConfig;

const service = new UploadsService(config);

/* Smallest valid PNG header bytes — content is irrelevant, only the envelope. */
const png = (bytes: number) =>
  `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('UploadsService.save', () => {
  it('stores a valid image and returns a served URL under the public base', async () => {
    const { url } = await service.save(png(100));
    expect(url).toMatch(/^http:\/\/front-door\/api\/uploads\/[a-f0-9]{32}\.png$/);
  });

  it('rejects a missing image', async () => {
    await expect(service.save(undefined)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a non-data-URL string', async () => {
    await expect(service.save('https://evil/img.png')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unsupported MIME types with 415', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`;
    await expect(service.save(svg)).rejects.toMatchObject({ status: 415 });
  });

  it('rejects an empty payload', async () => {
    await expect(service.save('data:image/png;base64,')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an oversize payload with 413', async () => {
    await expect(service.save(png(2048))).rejects.toMatchObject({ status: 413 });
  });
});

describe('UploadsService.read', () => {
  it('round-trips stored bytes with the right MIME', async () => {
    const { url } = await service.save(png(64));
    const name = url.split('/').pop() as string;
    const { data, mime } = await service.read(name);
    expect(mime).toBe('image/png');
    expect(data.length).toBe(64);
  });

  it('rejects names that are not the stored format (traversal shape)', async () => {
    for (const name of ['../secret', 'a.png', `${'a'.repeat(32)}.exe`, '..%2f..%2fetc']) {
      await expect(service.read(name)).rejects.toBeInstanceOf(AppError);
    }
  });

  it('404s on a well-formed name that does not exist', async () => {
    await expect(service.read(`${'0'.repeat(32)}.png`)).rejects.toMatchObject({ status: 404 });
  });
});
