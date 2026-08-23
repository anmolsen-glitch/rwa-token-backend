/**
 * Register a DEDICATED claim-signing key on the ClaimIssuer.
 *
 *   npm run chain:rotate-claim-key -- --confirm
 *   NEW_CLAIM_PRIVATE_KEY=0x… npm run chain:rotate-claim-key -- --confirm
 *
 * WHY (CLAUDE.md §12). The attesting key is hot — it signs on every KYC
 * approval. The deployer/agent keys hold mint, freeze, and forced-transfer.
 * While one key does both, a single compromise of the busiest signing path also
 * hands over the ability to move investors' tokens.
 *
 * ERC-734 separates them: a cold MANAGEMENT key (purpose 1) administers the
 * contract; a hot CLAIM key (purpose 3) only attests. This script adds the
 * latter.
 *
 * THE NEW KEY NEVER SENDS A TRANSACTION, so it needs no ETH — it only produces
 * off-chain signatures that investors submit via addClaim. That is also why
 * rotating it is cheap: no funds to sweep.
 *
 * EXISTING CLAIMS ARE NOT INVALIDATED. Claims already signed by the management
 * key stay valid, because isClaimValid checks keyHasPurpose(signer, CLAIM) and a
 * MANAGEMENT key satisfies every purpose. This is additive.
 *
 * Deliberately NOT a migration: migrations are committed to git and this
 * handles key material.
 */
import { ethers } from 'ethers';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

const CLAIM_ISSUER_ABI = [
  'function keyHasPurpose(bytes32 _key, uint256 _purpose) view returns (bool)',
  'function getKeysByPurpose(uint256 _purpose) view returns (bytes32[])',
  'function addKey(bytes32 _key, uint256 _purpose, uint256 _keyType) returns (bool)',
];

const PURPOSE_MANAGEMENT = 1n;
const PURPOSE_CLAIM = 3n;
const KEY_TYPE_ECDSA = 1n;

const keyOf = (address: string): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address'], [address]));

function claimIssuerAddress(network: string): string {
  const file =
    process.env.ADDRESSES_FILE ??
    resolve(process.cwd(), '../rwa-token-production/config/deployed-addresses.json');
  if (!existsSync(file)) throw new Error(`Address book not found: ${file}`);
  const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { claimIssuer?: string }>;
  const addr = all[network]?.claimIssuer;
  if (!addr) throw new Error(`No claimIssuer for network "${network}" in the address book`);
  return addr;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const network = process.env.NETWORK ?? 'localhost';
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error('RPC_URL is not set');

  /* The MANAGEMENT key signs addKey. Today that is the same key configured as
     CLAIMISSUER_PRIVATE_KEY, which is precisely the situation being fixed —
     so allow an explicit override for when they have already diverged. */
  const managementKey =
    process.env.CLAIM_ISSUER_MANAGEMENT_KEY ?? process.env.CLAIMISSUER_PRIVATE_KEY;
  if (!managementKey) {
    throw new Error('Set CLAIM_ISSUER_MANAGEMENT_KEY (or CLAIMISSUER_PRIVATE_KEY)');
  }

  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const management = new ethers.Wallet(managementKey, provider);
  const contractAddress = claimIssuerAddress(network);
  const issuer = new ethers.Contract(contractAddress, CLAIM_ISSUER_ABI, management);

  const isManager = (await issuer.keyHasPurpose(
    keyOf(management.address),
    PURPOSE_MANAGEMENT,
  )) as boolean;
  if (!isManager) {
    throw new Error(
      `${management.address} is not a MANAGEMENT key on ${contractAddress} — cannot addKey.`,
    );
  }

  const newWallet = process.env.NEW_CLAIM_PRIVATE_KEY
    ? new ethers.Wallet(process.env.NEW_CLAIM_PRIVATE_KEY)
    : ethers.Wallet.createRandom();
  const newKeyId = keyOf(newWallet.address);

  if ((await issuer.keyHasPurpose(newKeyId, PURPOSE_CLAIM)) as boolean) {
    console.log(`[rotate] ${newWallet.address} already has CLAIM purpose — nothing to do.`);
    return;
  }

  console.log(`network            : ${network}`);
  console.log(`claim issuer       : ${contractAddress}`);
  console.log(`management key     : ${management.address}`);
  console.log(`NEW claim key      : ${newWallet.address}`);
  console.log(`claim keys before  : ${((await issuer.getKeysByPurpose(PURPOSE_CLAIM)) as string[]).length}`);

  if (!confirm) {
    console.log('\nDRY RUN — no transaction sent. Re-run with --confirm to execute.');
    return;
  }

  const tx = (await issuer.addKey(
    newKeyId,
    PURPOSE_CLAIM,
    KEY_TYPE_ECDSA,
  )) as ethers.ContractTransactionResponse;
  console.log(`\n[rotate] addKey sent ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[rotate] mined block=${receipt?.blockNumber} gas=${receipt?.gasUsed?.toString()}`);

  /* Verify against the chain rather than trusting the receipt. */
  const nowHasClaim = (await issuer.keyHasPurpose(newKeyId, PURPOSE_CLAIM)) as boolean;
  const alsoManagement = (await issuer.keyHasPurpose(newKeyId, PURPOSE_MANAGEMENT)) as boolean;
  if (!nowHasClaim) throw new Error('addKey mined but the key still lacks CLAIM purpose');
  if (alsoManagement) throw new Error('New key unexpectedly has MANAGEMENT purpose — not independent');

  console.log(`\n[rotate] verified: CLAIM=yes MANAGEMENT=no  -> independent`);
  console.log(`\nSet this and restart the API:`);
  console.log(`  CLAIMISSUER_PRIVATE_KEY=${newWallet.privateKey}`);
  console.log(
    `\nThe new key needs NO ETH — it only signs off-chain claims.\n` +
      `For production, generate it in KMS instead and set KMS_KEY_ID_CLAIMISSUER.\n` +
      `Note: ${management.address} remains a MANAGEMENT key and can therefore still\n` +
      `sign claims; move it to a multisig for full separation.`,
  );
}

main().catch((err: unknown) => {
  console.error('[rotate] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
