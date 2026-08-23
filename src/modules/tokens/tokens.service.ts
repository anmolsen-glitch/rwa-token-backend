import { Injectable } from '@nestjs/common';
import { ethers } from 'ethers';
import { ChainService } from '@shared/chain/chain.service';
import { DbService } from '@shared/db/db.service';
import { sql } from 'drizzle-orm';
import type { TenantContext } from '@shared/auth/tenant-context';
import { TokensRepository } from './tokens.repository';

export interface TokenView {
  symbol: string;
  address: string;
  issuerId: string;
  name?: string;
  decimals?: number;
  totalSupply?: string;
  paused?: boolean;
  /** null when the chain is unreachable — the row still lists. */
  onChain: boolean;
}

@Injectable()
export class TokensService {
  constructor(
    private readonly repo: TokensRepository,
    private readonly chain: ChainService,
    private readonly db: DbService,
  ) {}

  /**
   * List tokens with on-chain detail.
   *
   * A chain failure degrades to `onChain: false` rather than failing the whole
   * list — an operator still needs to see their assets when the RPC is down,
   * which is exactly when they are most likely to be looking.
   */
  async list(tenant: TenantContext): Promise<{ items: TokenView[] }> {
    const rows = await this.repo.list(tenant);
    const items = await Promise.all(
      rows.map(async (r): Promise<TokenView> => {
        const base = { symbol: r.symbol, address: r.address, issuerId: r.issuerId };
        try {
          const c = this.chain.token(r.address);
          const [name, decimals, totalSupply, paused] = await Promise.all([
            c.name() as Promise<string>,
            c.decimals() as Promise<bigint>,
            c.totalSupply() as Promise<bigint>,
            c.paused() as Promise<boolean>,
          ]);
          return {
            ...base,
            name,
            decimals: Number(decimals),
            totalSupply: ethers.formatUnits(totalSupply, Number(decimals)),
            paused,
            onChain: true,
          };
        } catch {
          return { ...base, onChain: false };
        }
      }),
    );
    return { items };
  }

  async get(tenant: TenantContext, symbol: string): Promise<TokenView> {
    const r = await this.repo.require(tenant, symbol);
    const c = this.chain.token(r.address);
    const [name, decimals, totalSupply, paused] = await Promise.all([
      c.name() as Promise<string>,
      c.decimals() as Promise<bigint>,
      c.totalSupply() as Promise<bigint>,
      c.paused() as Promise<boolean>,
    ]);
    return {
      symbol: r.symbol,
      address: r.address,
      issuerId: r.issuerId,
      name,
      decimals: Number(decimals),
      totalSupply: ethers.formatUnits(totalSupply, Number(decimals)),
      paused,
      onChain: true,
    };
  }

  /**
   * The cap table, served from the INDEXED balances — not the chain.
   *
   * Reading per-holder balances on-chain would be one RPC call per holder. The
   * indexer exists precisely so this is one query. Freshness is therefore the
   * indexer's cursor, which is why its health matters.
   */
  async capTable(tenant: TenantContext, symbol: string) {
    const r = await this.repo.require(tenant, symbol);
    /* Decimals from the indexer cursor, not a chain call — the cap table is
       served from the indexer DB so it is instant and free of RPC load. */
    const state = await this.repo.indexerStateFor(r.address);
    const decimals = state?.decimals ?? 0;

    const rows = await this.db.scoped(tenant, async (tx) => {
      const res = await tx.execute(sql`
        SELECT address, balance FROM balances
         WHERE lower(token) = lower(${r.address}) AND balance <> 0
         ORDER BY balance DESC
      `);
      return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
        address: string;
        balance: string;
      }>;
    });

    const raw = rows.map((h) => ({ address: h.address, balance: BigInt(h.balance) }));
    const totalSupply = raw.reduce((sum, h) => sum + h.balance, 0n);
    const fmt = (v: bigint) => ethers.formatUnits(v, decimals);

    return {
      token: r.address,
      symbol: r.symbol,
      decimals,
      totalSupply: fmt(totalSupply),
      holderCount: raw.length,
      lastIndexedBlock: state?.lastIndexedBlock ?? 0,
      holders: raw.map((h) => ({
        address: h.address,
        balance: fmt(h.balance),
        percent:
          totalSupply > 0n ? Math.round(Number((h.balance * 1000000n) / totalSupply)) / 10000 : 0,
      })),
    };
  }

  async holder(tenant: TenantContext, symbol: string, address: string) {
    const r = await this.repo.require(tenant, symbol);
    const c = this.chain.token(r.address);
    const decimals = Number(await c.decimals());
    const [balance, frozen, frozenTokens] = await Promise.all([
      c.balanceOf(address) as Promise<bigint>,
      c.isFrozen(address) as Promise<boolean>,
      c.getFrozenTokens(address) as Promise<bigint>,
    ]);
    return {
      symbol: r.symbol,
      address,
      balance: ethers.formatUnits(balance, decimals),
      frozen,
      frozenTokens: ethers.formatUnits(frozenTokens, decimals),
    };
  }

  /** Recent transfers from the index. */
  async transfers(tenant: TenantContext, symbol: string, limit: number) {
    const r = await this.repo.require(tenant, symbol);
    const state = await this.repo.indexerStateFor(r.address);
    const decimals = state?.decimals ?? 0;
    const rows = await this.db.scoped(tenant, async (tx) => {
      const res = await tx.execute(sql`
        SELECT tx_hash, log_index, block_number, from_addr, to_addr, value, kind
          FROM transfers WHERE lower(token) = lower(${r.address})
         ORDER BY block_number DESC, log_index DESC LIMIT ${limit}
      `);
      return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
        tx_hash: string;
        block_number: string;
        from_addr: string;
        to_addr: string;
        value: string;
        kind: string;
      }>;
    });
    return {
      symbol: r.symbol,
      items: rows.map((t) => ({
        block: Number(t.block_number),
        txHash: t.tx_hash,
        kind: t.kind,
        from: t.from_addr,
        to: t.to_addr,
        value: ethers.formatUnits(BigInt(t.value), decimals),
      })),
    };
  }
}
