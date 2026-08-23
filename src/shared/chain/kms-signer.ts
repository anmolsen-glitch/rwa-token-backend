/**
 * An ethers Signer backed by AWS KMS.
 *
 * The private key is generated inside KMS (an asymmetric ECC_SECG_P256K1 /
 * secp256k1 key, SIGN_VERIFY) and NEVER leaves the HSM — we only ever ask KMS to
 * sign a 32-byte digest. That's the whole point of the `kms` signer mode: the
 * same code that signs with a local key on the Hardhat chain signs with a vaulted
 * key on mainnet, by config alone.
 *
 * What we have to do by hand (because KMS speaks ASN.1, not Ethereum):
 *   1. Derive the address: GetPublicKey returns a DER SPKI; the last 65 bytes are
 *      the uncompressed point 0x04‖X‖Y → keccak256 → address.
 *   2. Sign: KMS returns a DER ECDSA signature; we parse {r,s}, enforce low-S
 *      (Ethereum rejects high-S), and recover the parity bit `v` by checking which
 *      of the two candidates recovers our own address.
 *
 * Local testing without an AWS bill: run LocalStack and set KMS_ENDPOINT to it.
 *   awslocal kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY
 *   SIGNER_TYPE=kms KMS_ENDPOINT=http://localhost:4566 KMS_KEY_ID_AGENT=<id> ...
 *
 * PORTED VERBATIM from ../rwa-token-backend/src/lib/kmsSigner.ts. Deliberately
 * NOT refactored into a Nest provider: it is a plain ethers Signer with no
 * framework coupling, and its DER parsing / low-S normalisation / parity
 * recovery is exactly the code that must not change during a migration. Its
 * test (test/kms-signer.spec.ts) is the original, unedited apart from the
 * import path.
 */
import { ethers } from "ethers";
import { KMSClient, GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const HALF_N = SECP256K1_N / 2n;

let client: KMSClient | null = null;
function kms(): KMSClient {
  if (!client) {
    client = new KMSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(process.env.KMS_ENDPOINT ? { endpoint: process.env.KMS_ENDPOINT } : {}),
    });
  }
  return client;
}

/** Read one DER element's value bytes, returning [value, nextOffset]. */
function readDer(buf: Uint8Array, offset: number, expectedTag: number): [Uint8Array, number] {
  if (buf[offset] !== expectedTag) throw new Error(`DER: expected tag 0x${expectedTag.toString(16)}`);
  offset += 1;
  let len = buf[offset++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset++];
  }
  return [buf.slice(offset, offset + len), offset + len];
}

/** DER ECDSA signature → {r, s} as bigints. */
function parseEcdsaSig(der: Uint8Array): { r: bigint; s: bigint } {
  const [seq] = readDer(der, 0, 0x30);
  const [rBytes, afterR] = readDer(seq, 0, 0x02);
  const [sBytes] = readDer(seq, afterR, 0x02);
  return { r: BigInt(ethers.hexlify(rBytes)), s: BigInt(ethers.hexlify(sBytes)) };
}

/** Uncompressed secp256k1 point from a DER SPKI public key (the trailing 0x04‖X‖Y). */
export function publicKeyFromSpki(spki: Uint8Array): string {
  const raw = spki.slice(spki.length - 65);
  if (raw[0] !== 0x04) throw new Error("KMS public key is not an uncompressed secp256k1 point");
  return ethers.hexlify(raw);
}

export class KmsSigner extends ethers.AbstractSigner {
  readonly keyId: string;
  #address: string | null = null;

  constructor(keyId: string, provider?: ethers.Provider | null) {
    super(provider ?? undefined);
    this.keyId = keyId;
  }

  connect(provider: ethers.Provider | null): KmsSigner {
    return new KmsSigner(this.keyId, provider);
  }

  async getAddress(): Promise<string> {
    if (this.#address) return this.#address;
    const res = await kms().send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    if (!res.PublicKey) throw new Error(`KMS key ${this.keyId} returned no public key`);
    this.#address = ethers.computeAddress(publicKeyFromSpki(res.PublicKey));
    return this.#address;
  }

  /** Ask KMS to sign a 32-byte digest, returning an Ethereum signature. */
  async #signDigest(digest: string): Promise<ethers.Signature> {
    const res = await kms().send(
      new SignCommand({
        KeyId: this.keyId,
        Message: ethers.getBytes(digest),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      })
    );
    if (!res.Signature) throw new Error("KMS returned no signature");
    let { r, s } = parseEcdsaSig(res.Signature);
    if (s > HALF_N) s = SECP256K1_N - s; // enforce low-S

    const address = (await this.getAddress()).toLowerCase();
    const rHex = ethers.toBeHex(r, 32);
    const sHex = ethers.toBeHex(s, 32);
    for (const yParity of [0, 1] as const) {
      const sig = ethers.Signature.from({ r: rHex, s: sHex, yParity });
      if (ethers.recoverAddress(digest, sig).toLowerCase() === address) return sig;
    }
    throw new Error("KMS signature did not recover to the signer address");
  }

  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    const pop = await this.populateTransaction(tx);
    delete (pop as any).from; // Transaction.from() rejects a `from` field
    const unsigned = ethers.Transaction.from(pop as any);
    unsigned.signature = await this.#signDigest(unsigned.unsignedHash);
    return unsigned.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return (await this.#signDigest(ethers.hashMessage(message))).serialized;
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    const hash = ethers.TypedDataEncoder.hash(domain, types, value);
    return (await this.#signDigest(hash)).serialized;
  }
}
