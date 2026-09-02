import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { RedisService } from '@shared/redis/redis.service';
import { ChainService } from '@shared/chain/chain.service';
import { AppConfig } from '@shared/config/app-config.service';
import { OfferingsRepository } from './offerings.repository';
import { ethers } from 'ethers';

const LOCKUP_ABI = ['function getLockupDuration(address compliance) view returns (uint256)'];

@Processor('offerings-sync')
@Injectable()
export class OfferingsSyncWorker extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(OfferingsSyncWorker.name);

  constructor(
    @InjectQueue('offerings-sync') private readonly queue: Queue,
    private readonly redis: RedisService,
    private readonly chain: ChainService,
    private readonly config: AppConfig,
    private readonly repo: OfferingsRepository,
  ) {
    super();
  }

  onModuleInit() {
    // Run asynchronously to not block NestJS boot if Redis is down
    setTimeout(async () => {
      try {
        // 1. Trigger an immediate sync on boot so the cache isn't empty for the first 60 seconds
        await this.queue.add('sync-tokens', {});
        
        // 2. Register the repeatable job to run every 60 seconds.
        await this.queue.upsertJobScheduler(
          'sync-tokens',
          { every: 60000 },
          { name: 'sync-tokens', data: {} }
        );
        this.logger.log('Offerings sync repeatable job scheduled & immediate sync dispatched');
      } catch (err) {
        this.logger.error('Failed to schedule offerings sync jobs (is Redis down?)', err);
      }
    }, 0);
  }

  async process(job: Job<any, any, string>): Promise<any> {
    if (job.name !== 'sync-tokens') return;
    
    // Fetch all active tokens from the database
    // Note: In a production app with thousands of tokens, this would be chunked.
    const offerings = await this.repo.list({ kind: 'platform' });
    const symbols = offerings.map((o) => o.tokenSymbol).filter(Boolean) as string[];
    
    if (symbols.length === 0) return { synced: 0 };

    let synced = 0;
    const moduleAddr = this.config.get('LOCKUP_MODULE');

    // We do them sequentially to not hammer the RPC too hard, 
    // since this runs in the background anyway.
    for (const symbol of symbols) {
      try {
        const tokenAddr = await this.repo.findTokenAddressBySymbol(symbol);
        if (!tokenAddr) continue;

        const tokenContract = this.chain.token(tokenAddr);
        const owner = (await tokenContract.owner()) as string;
        
        let lockupDays: number | null = null;
        if (moduleAddr) {
          const compliance = (await tokenContract.compliance()) as string;
          const lockup = new ethers.Contract(moduleAddr, LOCKUP_ABI, this.chain.provider);
          lockupDays = Math.round(Number(await lockup.getLockupDuration(compliance)) / 86400);
        }

        // Write to Redis cache
        const pipeline = this.redis.client.pipeline();
        pipeline.set(`token:owner:${tokenAddr}`, owner, 'EX', 300); // 5 min expiry
        if (lockupDays !== null) {
          pipeline.set(`token:lockup:${tokenAddr}`, lockupDays.toString(), 'EX', 300);
        } else {
          pipeline.set(`token:lockup:${tokenAddr}`, '-1', 'EX', 300);
        }

        // Token metadata for TokensService
        try {
          const [name, decimals, totalSupply, paused] = await Promise.all([
            tokenContract.name() as Promise<string>,
            tokenContract.decimals() as Promise<bigint>,
            tokenContract.totalSupply() as Promise<bigint>,
            tokenContract.paused() as Promise<boolean>,
          ]);
          pipeline.set(
            `token:meta:${tokenAddr}`,
            JSON.stringify({
              name,
              decimals: Number(decimals),
              totalSupply: totalSupply.toString(),
              paused,
            }),
            'EX',
            300
          );
        } catch { /* ignore if token doesn't fully conform */ }

        await pipeline.exec();

        synced++;
      } catch (err) {
        this.logger.warn({ err, symbol }, 'Failed to sync on-chain data for token');
      }
    }

    return { synced };
  }
}
