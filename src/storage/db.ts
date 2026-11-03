import Dexie, { type Table } from 'dexie';
import type { SaveStateV1 } from '../types/domain';

// ============================================================
// IndexedDB storage via Dexie. Main saves live here; localStorage
// only holds small UI settings. Schema migration supported through
// Dexie version chain + save.version field.
// ============================================================

export interface SaveRow {
  id?: number;
  slotName: string;
  createdAt: number;
  updatedAt: number;
  seed: string;
  difficulty: string;
  equityUsd: string;
  tick: number;
  state: SaveStateV1;
}

export class SimDatabase extends Dexie {
  saves!: Table<SaveRow, number>;
  runHistory!: Table<{ id?: number; ts: number; seed: string; startEquity: string; endEquity: string; durationTicks: number; cause: string }, number>;

  constructor() {
    super('cryptosim');
    this.version(1).stores({
      saves: '++id, slotName, updatedAt, seed',
      runHistory: '++id, ts, seed',
    });
    // this.version(2).stores({...}) — add future migrations here
  }
}

export const db = new SimDatabase();

export async function saveToSlot(slotName: string, state: SaveStateV1): Promise<void> {
  const existing = await db.saves.where('slotName').equals(slotName).first();
  const row: SaveRow = {
    slotName,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    seed: state.seed,
    difficulty: state.difficulty,
    equityUsd: state.portfolioHistory[state.portfolioHistory.length - 1]?.equityUsd ?? state.cashUsd,
    tick: state.tick,
    state,
  };
  if (existing) await db.saves.update(existing.id!, row);
  else await db.saves.add(row);
}

export async function loadSlot(slotName: string): Promise<SaveStateV1 | null> {
  const row = await db.saves.where('slotName').equals(slotName).first();
  if (!row) return null;
  return migrate(row.state);
}

export async function listSaves(): Promise<SaveRow[]> {
  return db.saves.orderBy('updatedAt').reverse().toArray();
}

export async function deleteSlot(slotName: string): Promise<void> {
  await db.saves.where('slotName').equals(slotName).delete();
}

export async function recordRunEnd(seed: string, startEq: string, endEq: string, ticks: number, cause: string): Promise<void> {
  await db.runHistory.add({ ts: Date.now(), seed, startEquity: startEq, endEquity: endEq, durationTicks: ticks, cause });
}

/** Simple forward migration by version field. */
export function migrate(state: SaveStateV1): SaveStateV1 {
  if ((state as { version?: number }).version !== 1) {
    // Unknown/older schema: coerce defaults so the game never hard-fails.
    return { ...state, version: 1 };
  }
  return state;
}

// ---- export/import JSON ----

export function exportJson(state: SaveStateV1): string {
  return JSON.stringify(state, null, 2);
}

export function importJson(text: string): SaveStateV1 {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !('seed' in parsed) || !('cashUsd' in parsed)) {
    throw new Error('Файл сейва не похож на SaveStateV1 (нет seed/cashUsd)');
  }
  return migrate(parsed as SaveStateV1);
}
