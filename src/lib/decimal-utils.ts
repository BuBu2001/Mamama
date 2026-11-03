import Decimal from 'decimal.js';

// Global decimal config: high precision, banker-ish rounding avoided —
// exchange convention: round fees DOWN for maker rebate context is overkill;
// we use ROUND_HALF_EVEN for display and ROUND_FLOOR never for money.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -18, toExpPos: 24 });

export const D = (v: string | number | Decimal): Decimal => new Decimal(v);
export const ZERO = D(0);

/** Money quantization: USD to 8 dp (satoshis of dollars), assets to 8 dp. */
export const qUsd = (d: Decimal): Decimal => d.toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN);
export const qAsset = (d: Decimal): Decimal => d.toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN);

export const usdStr = (d: Decimal): string => qUsd(d).toFixed(2);
export const rawStr = (d: Decimal): string => qUsd(d).toFixed(8);

export function max(a: Decimal, b: Decimal): Decimal { return a.gte(b) ? a : b; }
export function min(a: Decimal, b: Decimal): Decimal { return a.lte(b) ? a : b; }
