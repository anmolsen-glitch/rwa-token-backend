/**
 * The indexer: reads every deployed token's Transfer events into the database
 * so "who holds what" is answerable instantly, without hammering the chain.
 *
 * Ported from ../rwa-token-backend/src/lib/indexer.ts. The reorg walk-back and
 * the guarded reset are carried over faithfully — they are the parts that
 * corrupt balances silently when wrong.
 *
 * Design: one gap-free SYNC per token from `last_indexed_block + 1` to the
 * current head, in chunks. Polling by block RANGE rather than a subscription is
 * what guarantees no event is missed. `applyTransfers` is idempotent, so
 * overlapping ranges are harmless.
 *
 * TWO CHANGES FROM THE EXPRESS VERSION, both about running two apps at once:
 *
 * 1. DISABLED BY DEFAULT (`INDEXER_ENABLED`). During the strangler migration
 *    the Express app is still indexing. Two indexers on one database double the
 *    RPC load — which is exactly what saturated the endpoint on 2026-07-24 —
 *    and fight over the same cursor. Turn this on only when Express's is off.
 *
 * 2. A RENEWED LEASE. Even with the flag set, only one process may index. This
 *    closes the "indexer single-instance" gap from the readiness review — the
 *    flag alone is a convention, the lease is a guarantee.
 *
 *    NOT pg_try_advisory_lock: that is session-scoped, and behind Supavisor's
 *    transaction pooler two instances BOTH acquired it (measured 2026-08-22)
 *    because they landed on different backends. Same trap as `SET` vs
 *    `SET LOCAL`. The lease is a row, renewed each tick; a process that dies
 *    stops renewing and the lease lapses for someone else to take.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { AppConfig } from '@shared/config/app-config.service';
import { ChainService } from '@shared/chain/chain.service';
import { DbService } from '@shared/db/db.service';
import { IndexerRepository, type TransferInput } from './indexer.repository';
import { IndexerTokensRepository, type IndexedToken } from './indexer-tokens.repository';

const LEASE_ID = 'indexer';
/**
 * Comfortably longer than the poll interval so a slow sync does not drop the
 * lease mid-run, but short enough that a crashed process frees it quickly.
 */
const LEASE_TTL_SECONDS = 60;

@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Identifies THIS process as the lease holder. */
  private readonly leaseOwner = randomUUID();
  private holdsLease = false;

  /**
   * setInterval fires on a fixed schedule regardless of whether the previous
   * tick finished. When the RPC slows (or a token is catching up over thousands
   * of blocks) ticks pile up and each re-issues the same getLogs calls — that
   * pile-up is what saturated the endpoint. One sync at a time.
   */
  private syncing = false;

  constructor(
    private readonly config: AppConfig,
    private readonly chain: ChainService,
    private readonly db: DbService,
    private readonly repo: IndexerRepository,
    private readonly tokens: IndexerTokensRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('INDEXER_ENABLED')) {
      this.logger.log('indexer disabled (INDEXER_ENABLED=false) — Express is presumably indexing');
      return;
    }

    this.holdsLease = await this.db.acquireLease(LEASE_ID, this.leaseOwner, LEASE_TTL_SECONDS);
    if (!this.holdsLease) {
      /* Not an error: this is the lease doing its job. */
      this.logger.warn('another instance holds the indexer lease — not indexing in this process');
      return;
    }

    /*
     * The indexer must NEVER take down the API. An unreachable RPC used to
     * reject onModuleInit, which Nest treats as fatal — so a dead indexer
     * endpoint killed every unrelated endpoint too. Log it, start the poll
     * timer anyway, and recover on a later tick when the RPC returns.
     */
    try {
      await this.start();
    } catch (err) {
      this.logger.error({ err }, 'indexer: initial sync failed — will retry on the poll timer');
      this.startPolling();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.holdsLease) {
      /* Release early so a restart does not wait out the TTL. */
      await this.db.releaseLease(LEASE_ID, this.leaseOwner);
      this.holdsLease = false;
    }
  }

  private async start(): Promise<void> {
    const tokens = await this.tokens.list();
    if (tokens.length === 0) {
      this.logger.log('indexer: no tokens deployed on this network — skipping');
      return;
    }

    await this.syncAll(tokens);
    for (const t of tokens) {
      this.logger.log(
        `indexer: ${t.symbol} synced to head, holders=${await this.repo.holderCount(t.address)}`,
      );
    }

    this.startPolling();
  }

  private startPolling(): void {
    if (this.timer) return;
    const pollMs = this.config.get('INDEXER_POLL_MS');
    this.timer = setInterval(() => {
      if (this.syncing) return; // previous tick still running — do not stack
      this.syncing = true;
      /*
       * Renew the lease BEFORE each sync. If renewal fails another instance has
       * taken over (this one was probably paused or partitioned), so stop
       * indexing rather than writing concurrently with the new holder.
       */
      this.db
        .acquireLease(LEASE_ID, this.leaseOwner, LEASE_TTL_SECONDS)
        .then(async (renewed) => {
          if (!renewed) {
            this.logger.warn('indexer lease lost to another instance — stopping');
            this.holdsLease = false;
            if (this.timer) clearInterval(this.timer);
            this.timer = null;
            return;
          }
          await this.syncAll(await this.tokens.list());
        })
        .catch((err: unknown) => this.logger.error({ err }, 'indexer poll error'))
        .finally(() => {
          this.syncing = false;
        });
    }, pollMs);

    /* Log endpoint and chunk together: they are coupled — the usable chunk is
       bounded by whatever getLogs range THIS endpoint allows — and a mismatch
       shows up as an endless "sync error" loop that is easy to misread. */
    this.logger.log(
      `indexer: polling every ${pollMs / 1000}s, chunk=${this.config.get('INDEXER_CHUNK')}, ` +
        `rpc=${new URL(this.config.get('INDEXER_RPC_URL') ?? this.config.get('RPC_URL')).host}`,
    );
  }

  /** A failure on one token must not block the others. */
  private async syncAll(tokens: IndexedToken[]): Promise<void> {
    const latest = await this.chain.indexerProvider.getBlockNumber();
    /* Stay CONFIRMATIONS blocks behind the head so short reorgs never reach us. */
    const safeHead = latest - this.config.get('INDEXER_CONFIRMATIONS');
    if (safeHead < 0) return;

    for (const token of tokens) {
      try {
        await this.syncToken(token, safeHead);
      } catch (err) {
        this.logger.error({ err, token: token.symbol }, 'indexer sync error');
      }
    }
  }

  private async syncToken(rec: IndexedToken, safeHead: number): Promise<void> {
    const tokenAddr = rec.address.toLowerCase();
    const contract = this.chain.token(rec.address, this.chain.indexerProvider);

    /* Reconcile with the head (guarded reset), repair reorgs, THEN read the
       cursor — so we never work off a value a reset or rewind just changed. */
    await this.ensureState(rec, safeHead);
    await this.handleReorg(rec, safeHead);

    const state = await this.repo.getState(tokenAddr);
    const from = (state?.lastIndexedBlock ?? -1) + 1;
    if (from > safeHead) return;

    const chunk = this.config.get('INDEXER_CHUNK');
    for (let start = from; start <= safeHead; start += chunk) {
      const end = Math.min(start + chunk - 1, safeHead);
      const logs = await contract.queryFilter(contract.filters.Transfer(), start, end);
      const events = logs
        .filter((l): l is ethers.EventLog => l instanceof ethers.EventLog)
        .map(IndexerService.toInput);

      await this.repo.applyTransfers(tokenAddr, events);

      /* Stamp the cursor with the end block's hash so the next tick can spot a
         reorg, and retain it for the fork-point search on a deep one. */
      const endBlock = await this.chain.indexerProvider.getBlock(end);
      await this.repo.setLastIndexedBlock(tokenAddr, end, endBlock?.hash ?? null);
      if (endBlock?.hash) {
        await this.repo.recordBlockHash(
          tokenAddr,
          end,
          endBlock.hash,
          this.config.get('INDEXER_HASH_RETENTION'),
        );
      }
    }
  }

  private static toInput(log: ethers.EventLog): TransferInput {
    return {
      from: log.args[0] as string,
      to: log.args[1] as string,
      value: log.args[2] as bigint,
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
    };
  }

  /**
   * Reconcile the cursor with the live head.
   *
   * A head reported BEHIND our cursor might be a genuine chain reset — or just
   * a lagging / load-balanced RPC node briefly serving an older block. We must
   * NOT wipe the index on a single such observation, so we stamp when it was
   * first seen and only reset once it has stayed behind for a sustained window.
   * The marker clears the moment the head catches up.
   */
  private async ensureState(rec: IndexedToken, latest: number): Promise<void> {
    const tokenAddr = rec.address.toLowerCase();
    let state = await this.repo.getState(tokenAddr);

    if (state && latest < state.lastIndexedBlock) {
      const firstSeen = state.chainBehindSince ? Date.parse(state.chainBehindSince) : null;
      if (firstSeen === null) {
        await this.repo.markChainBehind(tokenAddr);
        this.logger.warn(
          `${rec.symbol}: chain head ${latest} behind cursor ${state.lastIndexedBlock} — watching before any reset (could be a lagging RPC)`,
        );
        return;
      }
      if (Date.now() - firstSeen < this.config.get('INDEXER_RESET_CONFIRM_MS')) {
        this.logger.warn(`${rec.symbol}: still behind cursor — within confirm window, not resetting`);
        return;
      }
      this.logger.log(`${rec.symbol}: chain reset confirmed (sustained behind cursor) — resetting`);
      await this.repo.resetTokenData(tokenAddr);
      state = null;
    } else if (state?.chainBehindSince) {
      await this.repo.clearChainBehind(tokenAddr); // head caught up — false alarm
    }

    if (!state) {
      const decimals = Number(await this.chain.token(rec.address).decimals());
      const configured = this.config.get('INDEXER_START_BLOCK');
      /* Start from the configured block so a token on a non-genesis chain does
         not trigger a scan of millions of empty blocks. Never seed ahead of the
         current head. */
      const start = configured >= 0 ? Math.min(configured, latest + 1) : 0;
      await this.repo.upsertState({
        token: tokenAddr,
        symbol: rec.symbol,
        decimals,
        lastIndexedBlock: start - 1,
      });
    }
  }

  /**
   * Detect and recover from a reorg.
   *
   * If the cursor block's stored hash no longer matches the chain, the history
   * we indexed was rolled back. We walk the retained hash ledger newest→oldest
   * to find the REAL fork point — the deepest block whose stored hash still
   * matches — and rewind exactly there, so a reorg deeper than a fixed guess is
   * fully recovered rather than silently left corrupt.
   *
   * Only runs when the chain is at or ahead of the cursor. A head reported
   * behind is ensureState's business (guarded reset), never a rewind trigger.
   */
  private async handleReorg(rec: IndexedToken, safeHead: number): Promise<void> {
    const tokenAddr = rec.address.toLowerCase();
    const state = await this.repo.getState(tokenAddr);
    if (!state || state.lastIndexedBlock < 0 || !state.lastIndexedHash) return;
    if (safeHead < state.lastIndexedBlock) return; // chain behind — not a reorg signal

    const block = await this.chain.indexerProvider.getBlock(state.lastIndexedBlock);
    if (block && block.hash === state.lastIndexedHash) return; // chain intact

    const retention = this.config.get('INDEXER_HASH_RETENTION');
    const stored = await this.repo.recentBlockHashes(tokenAddr, retention);

    let ancestor = -1;
    for (const { block: bn, hash } of stored) {
      if (bn >= state.lastIndexedBlock) continue; // skip the known-bad cursor itself
      const chainBlock = await this.chain.indexerProvider.getBlock(bn);
      if (chainBlock && chainBlock.hash === hash) {
        ancestor = bn;
        break;
      }
    }

    if (ancestor < 0) {
      /* Fork is deeper than our retained hashes — fall back to a bounded rewind
         rather than giving up and leaving the index wrong. */
      ancestor = Math.max(state.lastIndexedBlock - this.config.get('INDEXER_REORG_DEPTH'), -1);
      this.logger.warn(
        `${rec.symbol}: reorg deeper than retained hashes — bounded rewind to ${ancestor} (increase INDEXER_HASH_RETENTION)`,
      );
    } else {
      this.logger.warn(
        `${rec.symbol}: reorg detected at cursor ${state.lastIndexedBlock} — rewinding to ancestor ${ancestor} and replaying`,
      );
    }

    await this.repo.rewindToBlock(tokenAddr, ancestor);
    await this.repo.pruneBlockHashesAbove(tokenAddr, ancestor);
  }
}
