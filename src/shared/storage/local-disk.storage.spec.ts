/**
 * Local-disk storage. These assertions are about the properties that make it
 * safe to hold passports on an EC2 volume, not about file I/O working.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalDiskStorage } from './local-disk.storage';

const root = mkdtempSync(join(tmpdir(), 'kycdocs-'));
const key = randomBytes(32);
const store = new LocalDiskStorage(root, key);
const plain = new LocalDiskStorage(root, null);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(64)]);

describe('encryption at rest', () => {
  it('round-trips the exact bytes', async () => {
    const s = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    expect(await store.get(s.key)).toEqual(JPEG);
  });

  it('writes ciphertext — the plaintext is NOT on disk', async () => {
    const s = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    const raw = readFileSync(join(root, s.key));
    /* A stolen EBS snapshot must not be a pile of readable passports. */
    expect(raw.includes(JPEG)).toBe(false);
    expect(raw.subarray(0, 3)).not.toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(s.encrypted).toBe(true);
  });

  it('hashes the PLAINTEXT, so integrity survives a key rotation', async () => {
    const a = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    const b = await plain.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    /* Same document, different storage mode -> same sha256. */
    expect(a.sha256).toBe(b.sha256);
  });

  it('fails loudly if the file is tampered with', async () => {
    const s = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    const path = join(root, s.key);
    const raw = readFileSync(path);
    raw[raw.length - 1] ^= 0xff;
    require('node:fs').writeFileSync(path, raw);
    /* GCM authenticates: altered bytes must throw, never decrypt to garbage. */
    await expect(store.get(s.key)).rejects.toThrow();
  });

  it('produces a different ciphertext each time (fresh IV)', async () => {
    const a = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    const b = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    expect(readFileSync(join(root, a.key))).not.toEqual(readFileSync(join(root, b.key)));
  });
});

describe('key generation', () => {
  it('never puts the user filename in the path', async () => {
    const s = await store.put(JPEG, { accountId: '9', filename: '../../etc/passwd' });
    /* Path traversal is removed as a CATEGORY, not sanitised for. */
    expect(s.key).not.toContain('..');
    expect(s.key).not.toContain('passwd');
    expect(s.key.startsWith('9/')).toBe(true);
  });

  it('shards by account, so erasure is a directory removal', async () => {
    const s = await store.put(JPEG, { accountId: '42', filename: 'x.jpg' });
    expect(s.key.split('/')[0]).toBe('42');
  });

  it('refuses a key that escapes the storage root', async () => {
    await expect(store.get('../../../etc/passwd')).rejects.toThrow(/escapes the storage root/);
  });
});

describe('permissions', () => {
  it('writes files readable only by the process user (0600)', async () => {
    const s = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    expect(statSync(join(root, s.key)).mode & 0o777).toBe(0o600);
  });
});

describe('delete', () => {
  it('is idempotent — already gone is the desired end state', async () => {
    const s = await store.put(JPEG, { accountId: '1', filename: 'p.jpg' });
    await store.delete(s.key);
    await expect(store.delete(s.key)).resolves.toBeUndefined();
  });
});
