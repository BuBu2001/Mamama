import Decimal from 'decimal.js';
import type { LedgerEntry, LedgerType, TaxCategory } from '../types/domain';
import { D, qUsd, rawStr } from '../lib/decimal-utils';
import { uid } from './rng';

// ============================================================
// Ledger: THE single source of truth for money. Balances can
// never be mutated directly — every change goes through
// applyDelta() which writes an auditable entry with a reason.
// Simplified double-entry: each entry has account + signed
// amount; the ledger as a whole is balanced against "exchange".
// ============================================================

export interface ApplyDeltaOpts {
  type: LedgerType;
  account: string;            // 'cash' | `asset:BTC` ...
  amount: Decimal;            // signed
  reason: string;             // REQUIRED cause
  tick: number;
  eventId?: string;
  orderId?: string;
  tradeId?: string;
  taxCategory?: TaxCategory;
  riskImpact?: string;
  legalImpact?: string;
  reputationImpact?: number;
}

export class Ledger {
  /** internal balances, decimal strings quantized to 8dp */
  private balances = new Map<string, Decimal>();
  public entries: LedgerEntry[] = [];

  getBalance(account: string): Decimal {
    return this.balances.get(account) ?? D(0);
  }

  setBalance(account: string, value: Decimal): void {
    this.balances.set(account, qUsd(value));
  }

  snapshotBalances(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.balances) out[k] = rawStr(v);
    return out;
  }

  loadBalances(bal: Record<string, string>): void {
    this.balances.clear();
    for (const [k, v] of Object.entries(bal)) this.balances.set(k, D(v));
  }

  /** Apply a signed delta atomically with an audit entry. Throws on negative cash unless allowNegative. */
  applyDelta(opts: ApplyDeltaOpts): LedgerEntry {
    const before = this.getBalance(opts.account);
    const after = qUsd(before.plus(opts.amount));
    if (after.lt(0) && opts.account === 'cash') {
      throw new Error(`Ledger: insufficient cash. Need ${opts.amount.abs().toFixed(2)} USD, have ${before.toFixed(2)}. Reason: ${opts.reason}`);
    }
    this.balances.set(opts.account, after);
    const entry: LedgerEntry = {
      id: uid('led'),
      tick: opts.tick,
      tsReal: Date.now(),
      type: opts.type,
      account: opts.account as LedgerEntry['account'],
      amount: rawStr(opts.amount),
      balanceBefore: rawStr(before),
      balanceAfter: rawStr(after),
      reason: opts.reason,
      eventId: opts.eventId,
      orderId: opts.orderId,
      tradeId: opts.tradeId,
      taxCategory: opts.taxCategory,
      riskImpact: opts.riskImpact,
      legalImpact: opts.legalImpact,
      reputationImpact: opts.reputationImpact,
    };
    this.entries.push(entry);
    // keep memory bounded in long sessions
    if (this.entries.length > 5000) this.entries.splice(0, 1000);
    return entry;
  }

  loadEntries(entries: LedgerEntry[]): void {
    this.entries = [...entries];
  }
}
