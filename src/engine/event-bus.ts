import type { EventType, GameEvent } from '../types/domain';
import { uid } from './rng';

// ============================================================
// Event bus: decouples engine from React. Engine emits typed
// events; UI/store subscribe. Also used to build the event log.
// ============================================================

export interface BusEventMap {
  PRICE_UPDATED: { symbol: string; price: number; prev: number; reason: string };
  ORDER_CREATED: { orderId: string };
  ORDER_FILLED: { tradeId: string; orderId: string };
  ORDER_CANCELLED: { orderId: string };
  ORDER_REJECTED: { orderId: string; why: string };
  POSITION_OPENED: { symbol: string };
  POSITION_CLOSED: { symbol: string };
  LIQUIDATION_TRIGGERED: { symbol: string };
  FEE_CHARGED: { entryId: string };
  TAX_ACCRUED: { recordId: string };
  NEWS_PUBLISHED: { newsId: string };
  REGULATORY_ALERT: { caseId: string };
  HACK_ATTEMPT: { success: boolean };
  ACCOUNT_FROZEN: { amountUsd: string };
  REPUTATION_CHANGED: { delta: number; total: number };
  BOT_ACTION: { agentId: string; action: string };
  SIMULATION_TICK: { tick: number };
  SAVE_COMPLETED: { tick: number };
  DATA_SOURCE_CHANGED: { status: string };
  SPEED_CHANGED: { speed: number };
  GAME_EVENT: { event: GameEvent };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<K extends keyof BusEventMap>(type: K, fn: Handler<BusEventMap[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn as Handler<any>);
    return () => set!.delete(fn as Handler<any>);
  }

  emit<K extends keyof BusEventMap>(type: K, payload: BusEventMap[K]): void {
    const set = this.handlers.get(type);
    if (set) for (const fn of set) {
      try { fn(payload); } catch (e) { console.error('[event-bus] handler error', type, e); }
    }
  }

  offAll(): void { this.handlers.clear(); }
}

/** Helper to construct a fully-attributed GameEvent (every event has a cause). */
export function makeGameEvent(
  tick: number,
  type: EventType,
  severity: GameEvent['severity'],
  title: string,
  message: string,
  data?: Record<string, unknown>,
  explanation?: GameEvent['explanation'],
): GameEvent {
  return {
    id: uid('evt'),
    tick,
    tsReal: Date.now(),
    type,
    severity,
    title,
    message,
    data,
    explanation,
  };
}
