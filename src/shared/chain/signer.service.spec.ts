/**
 * Signer port parity + the production safety guard.
 *
 * The addresses asserted here are the well-known Hardhat accounts #0/#1/#2 that
 * the Express app's DEV_KEYS map to. If a port had mangled a key, or swapped
 * two roles, these would change — which is exactly the class of silent error a
 * migration introduces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { SignerService, SIGNER_ROLES } from './signer.service';
import type { AppConfig } from '../config/app-config.service';
import type { ChainService } from './chain.service';

/** Hardhat accounts #0/#1/#2 — the addresses DEV_KEYS must derive to. */
const EXPECTED = {
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  agent: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  claimIssuer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
} as const;

function make(opts: { signerType?: string; production?: boolean } = {}) {
  const config = {
    /* Mirrors AppConfig: SIGNER_TYPE from the option, everything else from the
       environment the test set up. */
    get: (k: string) => (k === 'SIGNER_TYPE' ? (opts.signerType ?? 'local') : process.env[k]),
    isProduction: opts.production ?? false,
    isDevelopment: !opts.production,
  } as unknown as AppConfig;

  /* A null provider is fine: deriving an address never touches the network. */
  const chain = { provider: null } as unknown as ChainService;
  return new SignerService(config, chain);
}

const KEY_VARS = SIGNER_ROLES.map((r) => `${r.toUpperCase()}_PRIVATE_KEY`);

const KMS_VARS = SIGNER_ROLES.map((r) => `KMS_KEY_ID_${r.toUpperCase()}`);

afterEach(() => {
  for (const v of [...KEY_VARS, ...KMS_VARS]) delete process.env[v];
  vi.unstubAllEnvs();
});

describe('local signers derive the expected addresses', () => {
  for (const role of SIGNER_ROLES) {
    it(`${role} -> ${EXPECTED[role]}`, async () => {
      const addr = await make().addressFor(role);
      expect(addr).toBe(EXPECTED[role]);
    });
  }

  it('gives each role a DISTINCT key', async () => {
    const svc = make();
    const addrs = await Promise.all(SIGNER_ROLES.map((r) => svc.addressFor(r)));
    expect(new Set(addrs).size).toBe(SIGNER_ROLES.length);
  });

  it('prefers an explicit <ROLE>_PRIVATE_KEY over the dev key', async () => {
    const wallet = ethers.Wallet.createRandom();
    process.env.AGENT_PRIVATE_KEY = wallet.privateKey;
    expect(await make().addressFor('agent')).toBe(wallet.address);
  });

  it('caches the signer instance — the cache holds nonce state', () => {
    const svc = make();
    expect(svc.get('agent')).toBe(svc.get('agent'));
  });

  it('wraps signers in a NonceManager so back-to-back sends do not reuse a nonce', () => {
    /* An onboard sends several transactions in a row. Without this the second
       reuses a nonce and is silently dropped. */
    expect(make().get('agent')).toBeInstanceOf(ethers.NonceManager);
  });
});

describe('production safety guard', () => {
  it('REFUSES to boot in production with dev keys', () => {
    /* Hardhat account #1 is a PUBLISHED private key. Booting mainnet with it
       hands mint/freeze/forced-transfer to anyone who reads the docs. */
    expect(() => make({ production: true }).onModuleInit()).toThrowError(/Refusing to start/);
  });

  it('boots in production when every role has an explicit key', () => {
    for (const v of KEY_VARS) process.env[v] = ethers.Wallet.createRandom().privateKey;
    expect(() => make({ production: true }).onModuleInit()).not.toThrow();
  });

  it('boots in production under KMS without any local key', () => {
    expect(() => make({ production: true, signerType: 'kms' }).onModuleInit()).not.toThrow();
  });

  it('allows dev keys outside production', () => {
    expect(() => make({ production: false }).onModuleInit()).not.toThrow();
  });

  it('names the roles that are missing a key', () => {
    process.env.AGENT_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
    expect(() => make({ production: true }).onModuleInit()).toThrowError(/deployer, claimIssuer/);
  });
});

describe('kms mode', () => {
  it('fails loudly when the key id for a role is missing', () => {
    expect(() => make({ signerType: 'kms' }).get('agent')).toThrowError(/KMS_KEY_ID_AGENT/);
  });

  it('reads the KMS key id from config, not a hardcoded env lookup', () => {
    process.env.KMS_KEY_ID_AGENT = 'arn:aws:kms:test';
    expect(() => make({ signerType: 'kms' }).get('agent')).not.toThrow();
  });

  it('reports mode without leaking key material', () => {
    expect(make({ signerType: 'kms' }).mode()).toBe('kms');
    expect(make().mode()).toBe('local (DEV keys)');
  });
});
