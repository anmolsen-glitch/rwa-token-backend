/**
 * Chain access. Global because the provider, signers, and nonce state must be
 * ONE instance process-wide — a second SignerService would keep its own
 * NonceManagers and the two would collide on nonces.
 */
import { Global, Module } from '@nestjs/common';
import { ChainService } from './chain.service';
import { ClaimIssuerService } from './claim-issuer.service';
import { IdentityService } from './identity.service';
import { InfraService } from './infra.service';
import { SignerService } from './signer.service';
import { TxService } from './tx.service';

@Global()
@Module({
  providers: [ChainService, SignerService, TxService, IdentityService, InfraService, ClaimIssuerService],
  exports: [ChainService, SignerService, TxService, IdentityService, InfraService, ClaimIssuerService],
})
export class ChainModule {}
