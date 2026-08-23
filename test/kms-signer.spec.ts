/**
 * KMS signer adapter — gated behind RUN_KMS_TESTS (needs AWS KMS or LocalStack).
 *
 *   awslocal kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY
 *   RUN_KMS_TESTS=1 KMS_ENDPOINT=http://localhost:4566 \
 *     KMS_KEY_ID_AGENT=<keyId> AWS_REGION=us-east-1 \
 *     AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test npm test
 *
 * Proves the round trip: KMS signs a message, and the signature recovers to the
 * address derived from the KMS public key — i.e. our DER parsing + low-S + parity
 * recovery are all correct.
 */
import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { KmsSigner } from "../src/shared/chain/kms-signer";

const RUN = !!process.env.RUN_KMS_TESTS && !!process.env.KMS_KEY_ID_AGENT;

describe.skipIf(!RUN)("KmsSigner", () => {
  it("signs a message that recovers to its derived address", async () => {
    const signer = new KmsSigner(process.env.KMS_KEY_ID_AGENT!);
    const address = await signer.getAddress();
    expect(ethers.isAddress(address)).toBe(true);

    const sig = await signer.signMessage("hello from kms");
    expect(ethers.verifyMessage("hello from kms", sig).toLowerCase()).toBe(address.toLowerCase());
  });

  it("produces a low-S signature (Ethereum requirement)", async () => {
    const signer = new KmsSigner(process.env.KMS_KEY_ID_AGENT!);
    const sig = ethers.Signature.from(await signer.signMessage("low-s check"));
    const HALF_N = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
    expect(BigInt(sig.s) <= HALF_N).toBe(true);
  });
});
