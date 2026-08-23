/**
 * Deploy a T-REX token suite for an offering.
 *
 * Ported from ../rwa-token-backend/src/services/deploy.service.ts.
 *
 * One factory call deploys Token + IdentityRegistry + ModularCompliance, bound
 * to the shared modules and the claim issuer. The token OWNER is the ISSUER's
 * wallet; the platform's AGENT key is set as token + IR agent so the backend can
 * operate it — that is "platform-managed compliance", not custody.
 *
 * THE RECOVERY PATH IS THE SUBTLE PART. The factory enforces uniqueness on ITS
 * salt, and our records can diverge from that: if the process dies between the
 * transaction confirming and the row being written, the suite exists on-chain
 * with nothing pointing at it, and because the salt derives from the symbol,
 * every retry then reverts with "token already deployed" — making that symbol
 * unusable forever. So a salt the factory already knows is ADOPTED rather than
 * redeployed, but only after proving it is the same asset. The owner check is
 * load-bearing: it is the difference between resuming our own interrupted
 * deploy and silently binding a listing to a contract someone else controls.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import { AppError } from '@shared/errors/app-error';
import { AppConfig } from '@shared/config/app-config.service';
import { ChainService } from '@shared/chain/chain.service';
import { InfraService } from '@shared/chain/infra.service';
import { SignerService } from '@shared/chain/signer.service';
import { TxService } from '@shared/chain/tx.service';
import { ACCREDITED_TOPIC, KYC_TOPIC } from '@shared/chain/identity.service';

const TREX_FACTORY_ABI = [
  'function deployTREXSuite(string _salt, (address owner,string name,string symbol,uint8 decimals,address irs,address ONCHAINID,address[] irAgents,address[] tokenAgents,address[] complianceModules,bytes[] complianceSettings) _tokenDetails, (uint256[] claimTopics,address[] issuers,uint256[][] issuerClaims) _claimDetails)',
  'function getToken(string salt) view returns (address)',
];

const MAXHOLDERS_IFACE = new ethers.Interface(['function setMaxHolders(uint256 _max)']);
const LOCKUP_IFACE = new ethers.Interface(['function setLockupDuration(uint256 _duration)']);

export interface DeployInput {
  name: string;
  symbol: string;
  decimals: number;
  ownerWallet: string;
  maxHolders: number;
  lockupDays: number;
  requiresAccreditation: boolean;
}

@Injectable()
export class DeployService {
  private readonly logger = new Logger(DeployService.name);

  constructor(
    private readonly infra: InfraService,
    private readonly chain: ChainService,
    private readonly signers: SignerService,
    private readonly tx: TxService,
    private readonly config: AppConfig,
  ) {}

  async deploySuite(input: DeployInput): Promise<{ address: string; adopted: boolean }> {
    const infra = this.infra.require();
    const modules = this.config.moduleAddresses;

    const deployer = this.signers.get('deployer');
    const agentAddr = await this.signers.addressFor('agent');
    const salt = `${input.symbol}-${KYC_TOPIC}`;

    const factoryRead = new ethers.Contract(
      infra.trexFactory,
      TREX_FACTORY_ABI,
      this.chain.provider,
    );

    /* Adoption path — see the header. */
    const existing: string = await factoryRead.getToken(salt);
    if (existing && existing !== ethers.ZeroAddress) {
      const token = this.chain.token(existing);
      const [onChainOwner, onChainSymbol] = await Promise.all([
        token.owner() as Promise<string>,
        token.symbol() as Promise<string>,
      ]);
      if (ethers.getAddress(onChainOwner) !== ethers.getAddress(input.ownerWallet)) {
        throw AppError.conflict(
          'SYMBOL_OWNED_ELSEWHERE',
          `Symbol "${input.symbol}" is already deployed on-chain and owned by ${onChainOwner}, not this issuer. Choose a different symbol.`,
          { symbol: input.symbol, token: existing, owner: onChainOwner },
        );
      }
      if (String(onChainSymbol) !== input.symbol) {
        throw AppError.conflict(
          'SALT_COLLISION',
          `Salt "${salt}" already maps to a token with symbol "${onChainSymbol}".`,
          { symbol: input.symbol, token: existing },
        );
      }
      this.logger.warn(
        `deploy: ${input.symbol} already on-chain at ${existing} but missing from our records — adopting instead of redeploying`,
      );
      /* An interrupted deploy most likely died before the unpause — finish it. */
      await this.unpauseIfNeeded(input.symbol, existing);
      return { address: existing, adopted: true };
    }

    /* Compliance module settings, encoded and run during binding. */
    const complianceModules = [modules.maxHoldersModule, modules.lockupPeriodModule];
    const complianceSettings = [
      MAXHOLDERS_IFACE.encodeFunctionData('setMaxHolders', [input.maxHolders]),
      LOCKUP_IFACE.encodeFunctionData('setLockupDuration', [input.lockupDays * 24 * 60 * 60]),
    ];

    /* An accredited-only asset requires BOTH claims on-chain, so isVerified —
       and therefore any mint or transfer — passes only for accredited holders.
       The single trusted issuer attests both topics. */
    const requiredTopics = input.requiresAccreditation
      ? [KYC_TOPIC, ACCREDITED_TOPIC]
      : [KYC_TOPIC];

    const factory = new ethers.Contract(infra.trexFactory, TREX_FACTORY_ABI, deployer);
    await this.tx.submit(`deployTREXSuite ${input.symbol}`, () =>
      factory.deployTREXSuite(
        salt,
        {
          owner: input.ownerWallet,
          name: input.name,
          symbol: input.symbol,
          decimals: input.decimals,
          irs: ethers.ZeroAddress,
          ONCHAINID: ethers.ZeroAddress,
          irAgents: [agentAddr],
          tokenAgents: [agentAddr],
          complianceModules,
          complianceSettings,
        },
        { claimTopics: requiredTopics, issuers: [infra.claimIssuer], issuerClaims: [requiredTopics] },
      ) as Promise<ethers.ContractTransactionResponse>,
    );

    const address: string = await factoryRead.getToken(salt);
    if (!address || address === ethers.ZeroAddress) {
      throw new AppError('DEPLOY_FAILED', 502, 'Suite deployed but the token address is empty.');
    }
    await this.unpauseIfNeeded(input.symbol, address);
    return { address, adopted: false };
  }

  /**
   * The factory deploys tokens PAUSED. Unpause with the platform agent (set as
   * a token agent at deploy) so settlement can mint without a manual step.
   * Conditional, so both the fresh-deploy and adoption paths can re-run it.
   * Ported from ../rwa-token-backend/src/services/deploy.service.ts finishSuite.
   */
  private async unpauseIfNeeded(symbol: string, address: string): Promise<void> {
    if ((await this.chain.token(address).paused()) as boolean) {
      const writer = this.chain.token(address, this.signers.get('agent'));
      await this.tx.submit(`unpause ${symbol}`, () =>
        writer.unpause() as Promise<ethers.ContractTransactionResponse>,
      );
    }
  }
}
