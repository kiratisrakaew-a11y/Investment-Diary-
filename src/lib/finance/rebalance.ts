/**
 * Cost-aware rebalancing proposals (Roadmap Phase 4). Turns target weights into whole-lot buy/sell
 * quantities that can be paid for after costs. Proposals only — nothing here records transactions.
 *
 * Only what the mean-variance QP cannot do lives here: integer lots, commissions with a minimum,
 * VAT, slippage, sell tax, cash that must stay ≥ 0, minimum trade size, no-trade band and a
 * turnover cap. Holdings, prices and cash come from the existing ledger snapshot.
 */
import { z } from "zod";
import type { AssetClass } from "@/db/schema";
import type { Matrix } from "./mpt";

/** Stored in settings.trading_costs (percent units as entered in the UI). */
export const tradingCostsSchema = z.object({
  commissionPct: z.number().min(0).max(5).default(0).describe("Brokerage commission, % of trade value"),
  minCommission: z.number().min(0).default(0).describe("Minimum commission per trade (THB)"),
  vatPct: z.number().min(0).max(30).default(0).describe("VAT on commission, % (Thailand 7)"),
  slippageBps: z.number().min(0).max(500).default(0).describe("Expected price impact / spread, basis points of trade value"),
  sellTaxPct: z.number().min(0).max(5).default(0).describe("Tax on sell value, %"),
  minTradeValue: z.number().min(0).default(0).describe("Skip trades smaller than this (THB)"),
  lotSize: z
    .record(z.string(), z.number().positive())
    .default({ thai_stock: 100 })
    .describe("Default lot by asset class (SET board lot = 100 shares); assets.lot_size overrides; missing = 1"),
});
export type TradingCosts = z.infer<typeof tradingCostsSchema>;

export function lotFor(costs: TradingCosts, assetClass: AssetClass, assetLot: number | null | undefined) {
  return assetLot ?? costs.lotSize[assetClass] ?? 1;
}

export interface CostBreakdown {
  commission: number;
  vat: number;
  slippage: number;
  tax: number;
  total: number;
}

export function tradeCost(value: number, side: "buy" | "sell", c: TradingCosts): CostBreakdown {
  const v = Math.abs(value);
  if (v === 0) return { commission: 0, vat: 0, slippage: 0, tax: 0, total: 0 };
  const commission = Math.max((v * c.commissionPct) / 100, c.minCommission);
  const vat = (commission * c.vatPct) / 100;
  const slippage = (v * c.slippageBps) / 10_000;
  const tax = side === "sell" ? (v * c.sellTaxPct) / 100 : 0;
  return { commission, vat, slippage, tax, total: commission + vat + slippage + tax };
}

export type RebalanceObjective = "track" | "after_cost" | "min_cost" | "min_turnover";

export interface RebalanceAsset {
  symbol: string;
  /** THB per unit (price × FX); null when there is no usable price. */
  price: number | null;
  quantity: number;
  lot: number;
  /** Target share of the investable total; null = keep the current holding (not part of the target). */
  target: number | null;
  /** Largest THB value that can be traded (liquidity cap); omit for no cap. */
  maxTradeValue?: number;
  priceWarning?: string;
}

export interface RebalanceInput {
  assets: RebalanceAsset[];
  cash: number;
  extraCash: number;
  /** THB kept aside in cash, outside the targets. */
  cashReserve: number;
  costs: TradingCosts;
  objective: RebalanceObjective;
  /** Skip assets whose weight is within ± band of target (decimal). */
  noTradeBand: number;
  /** Max Σ|trade| as a share of the total (decimal); omit for none. */
  maxTurnover?: number;
  allowSell: boolean;
  /** Fractional units (no lots): trade to the continuous target exactly, scaling buys so cash covers costs; no lot search. */
  fractional?: boolean;
  /** Annualized covariance aligned with `assets` (null → weight-gap distance instead of tracking error). */
  cov: Matrix | null;
}

export interface RebalanceTrade {
  symbol: string;
  side: "buy" | "sell" | "hold";
  quantity: number;
  lots: number;
  price: number | null;
  value: number;
  cost: CostBreakdown;
  currentQuantity: number;
  finalQuantity: number;
  currentWeight: number;
  targetWeight: number | null;
  finalWeight: number;
  note?: string;
}

export interface RebalanceResult {
  ok: boolean;
  proposalOnly: true;
  objective: RebalanceObjective;
  trades: RebalanceTrade[];
  totals: { buy: number; sell: number; cost: number; turnover: number; turnoverPct: number };
  cash: { start: number; extra: number; reserve: number; end: number; targetWeight: number; finalWeight: number };
  total: { before: number; after: number };
  distance: { measure: "tracking_error" | "weight_gap"; before: number; after: number; continuousIdeal: number };
  violations: string[];
  warnings: string[];
}

const EPS = 1e-9;

export function rebalance(x: RebalanceInput): RebalanceResult {
  const n = x.assets.length;
  const violations: string[] = [];
  const warnings: string[] = [];
  const c = x.costs;

  const holdingsValue = x.assets.reduce((s, a) => s + (a.price ?? 0) * a.quantity, 0);
  const startCash = x.cash + x.extraCash;
  const total = holdingsValue + startCash - x.cashReserve; // investable total the targets refer to
  const targetSum = x.assets.reduce((s, a) => s + (a.target ?? 0), 0);
  const keptValue = x.assets.filter((a) => a.target == null).reduce((s, a) => s + (a.price ?? 0) * a.quantity, 0);
  if (targetSum > 1 + 1e-6) violations.push(`น้ำหนักเป้าหมายรวม ${(targetSum * 100).toFixed(2)}% เกิน 100%`);
  if (x.cashReserve > startCash + EPS) violations.push("เงินสดสำรองมากกว่าเงินสดที่มี");
  if (!(total > 0)) violations.push("มูลค่าพอร์ตที่ลงทุนได้ต้องมากกว่า 0");
  if (keptValue / Math.max(total, EPS) + targetSum > 1 + 1e-6) {
    warnings.push("สินทรัพย์ที่ไม่ได้กำหนดเป้าหมาย (คงไว้) รวมกับเป้าหมายเกิน 100% — เงินสดจะไม่พอซื้อครบ");
  }
  for (const a of x.assets) {
    if (a.price == null || !(a.price > 0)) {
      if ((a.target ?? 0) > 0 || (a.target === 0 && a.quantity > 0)) violations.push(`${a.symbol}: ไม่มีราคาที่ใช้ได้ — ซื้อขายไม่ได้`);
    }
    if (a.priceWarning) warnings.push(`${a.symbol}: ${a.priceWarning}`);
  }
  const tradable = x.assets.map((a) => a.price != null && a.price > 0 && a.target != null);

  // Weights measured on the investable total after costs (cash reserve excluded).
  const tgt = x.assets.map((a) => a.target ?? 0);
  const covOk = x.cov != null && x.cov.length === n;
  const distance = (q: number[], cash: number) => {
    const tot = q.reduce((s, qi, i) => s + qi * (x.assets[i].price ?? 0), 0) + cash - x.cashReserve;
    const w = q.map((qi, i) => (tot > 0 ? (qi * (x.assets[i].price ?? 0)) / tot : 0));
    // Kept (untargeted) holdings are compared with their own current weight, so they add no distance.
    const d = w.map((wi, i) => (x.assets[i].target == null ? 0 : wi - tgt[i]));
    if (covOk) return Math.sqrt(Math.max(0, d.reduce((s, di, i) => s + di * d.reduce((t, dj, j) => t + x.cov![i][j] * dj, 0), 0)));
    return Math.sqrt(d.reduce((s, di) => s + di * di, 0));
  };

  const q0 = x.assets.map((a) => a.quantity);
  const before = distance(q0, startCash);
  const empty = (ok: boolean): RebalanceResult => ({
    ok,
    proposalOnly: true,
    objective: x.objective,
    trades: [],
    totals: { buy: 0, sell: 0, cost: 0, turnover: 0, turnoverPct: 0 },
    cash: { start: x.cash, extra: x.extraCash, reserve: x.cashReserve, end: startCash, targetWeight: 1 - targetSum, finalWeight: 0 },
    total: { before: holdingsValue + startCash, after: holdingsValue + startCash },
    distance: { measure: covOk ? "tracking_error" : "weight_gap", before, after: before, continuousIdeal: 0 },
    violations,
    warnings,
  });
  if (violations.some((v) => v.includes("เกิน 100%") || v.includes("มากกว่า 0") || v.includes("สำรอง"))) return empty(false);

  // No-trade band: assets already within ± band of target are frozen.
  const weight0 = x.assets.map((a) => ((a.price ?? 0) * a.quantity) / total);
  const frozen = x.assets.map((a, i) => !tradable[i] || Math.abs(weight0[i] - tgt[i]) < x.noTradeBand);

  // State: proposed quantities and cash after all costs.
  const q = [...q0];
  const costOf = (i: number, qi: number) => {
    const v = (qi - q0[i]) * (x.assets[i].price ?? 0);
    return tradeCost(v, v >= 0 ? "buy" : "sell", c).total;
  };
  const cashFor = (qs: number[]) => startCash - qs.reduce((s, qi, i) => s + (qi - q0[i]) * (x.assets[i].price ?? 0) + costOf(i, qi), 0);
  const turnover = (qs: number[]) => qs.reduce((s, qi, i) => s + Math.abs(qi - q0[i]) * (x.assets[i].price ?? 0), 0);
  const totalCost = (qs: number[]) => qs.reduce((s, qi, i) => s + costOf(i, qi), 0);
  // Score in return units: distance plus a cost / turnover penalty (heuristic weights, documented).
  const score = (qs: number[]) => {
    const cash = cashFor(qs);
    const d = distance(qs, cash);
    const costShare = totalCost(qs) / total;
    const turnShare = turnover(qs) / total;
    switch (x.objective) {
      case "after_cost":
        return d + costShare;
      case "min_cost":
        return d + 10 * costShare;
      case "min_turnover":
        return d + 0.1 * turnShare;
      default:
        return d;
    }
  };
  const feasible = (qs: number[], i: number) => {
    const a = x.assets[i];
    const dq = qs[i] - q0[i];
    const v = Math.abs(dq) * (a.price ?? 0);
    if (qs[i] < -EPS) return false;
    if (dq < -EPS && !x.allowSell) return false;
    if (v > EPS && v < c.minTradeValue - EPS) return false;
    if (a.maxTradeValue != null && v > a.maxTradeValue + EPS) return false;
    if (x.maxTurnover != null && turnover(qs) > x.maxTurnover * total + EPS) return false;
    return cashFor(qs) >= x.cashReserve - EPS;
  };

  // 1) Continuous ideal → whole lots toward target (sells first so their proceeds fund buys).
  const ideal = x.assets.map((a, i) => (frozen[i] ? q0[i] : (tgt[i] * total) / (a.price as number)));
  const continuousIdeal = distance(ideal, startCash - ideal.reduce((s, qi, i) => s + (qi - q0[i]) * (x.assets[i].price ?? 0), 0));
  const order = x.assets.map((_, i) => i).filter((i) => !frozen[i]);
  if (x.fractional) {
    // Sells to the exact target, then one scale s ∈ [0, 1] on all buys: cash after trades and costs is
    // decreasing in s, so bisection finds the largest affordable s. Exact, no lot-by-lot search.
    for (const i of order.filter((i) => ideal[i] < q0[i])) {
      q[i] = tgt[i] === 0 ? 0 : ideal[i];
      if (!feasible(q, i)) q[i] = q0[i];
    }
    const buys = order.filter((i) => ideal[i] > q0[i]);
    const setS = (sc: number) => buys.forEach((i) => (q[i] = q0[i] + sc * (ideal[i] - q0[i])));
    const ok = () => cashFor(q) >= x.cashReserve - EPS && (x.maxTurnover == null || turnover(q) <= x.maxTurnover * total + EPS);
    setS(1);
    if (!ok()) {
      let lo = 0;
      let hi = 1;
      for (let k = 0; k < 100; k++) {
        const m = (lo + hi) / 2;
        setS(m);
        if (ok()) lo = m;
        else hi = m;
      }
      setS(lo);
    }
    // Per-asset limits that a common scale cannot satisfy: minimum trade size and liquidity caps.
    for (const i of buys) {
      const a = x.assets[i];
      const v = (q[i] - q0[i]) * (a.price ?? 0);
      if (a.maxTradeValue != null && v > a.maxTradeValue) q[i] = q0[i] + a.maxTradeValue / (a.price as number);
      if (v > EPS && v < c.minTradeValue - EPS) q[i] = q0[i];
    }
  }
  for (const i of x.fractional ? [] : order.filter((i) => ideal[i] < q0[i])) {
    const lot = x.assets[i].lot;
    const lots = Math.floor((q0[i] - ideal[i]) / lot + 1e-9);
    q[i] = q0[i] - lots * lot;
    // Fully exit a zero target even when the holding is not a whole number of lots (odd lot).
    if (tgt[i] === 0) q[i] = 0;
    if (!feasible(q, i)) q[i] = q0[i];
  }
  const buys = (x.fractional ? [] : order.filter((i) => ideal[i] > q0[i])).sort((a, b) => (ideal[b] - q0[b]) * (x.assets[b].price ?? 0) - (ideal[a] - q0[a]) * (x.assets[a].price ?? 0));
  for (const i of buys) {
    const lot = x.assets[i].lot;
    let lots = Math.floor((ideal[i] - q0[i]) / lot + 1e-9);
    while (lots > 0) {
      q[i] = q0[i] + lots * lot;
      if (feasible(q, i)) break;
      lots--;
    }
    if (lots <= 0) q[i] = q0[i];
  }

  // 2) Local search: one lot at a time (or a jump to the minimum trade size), best improvement first.
  let best = score(q);
  for (let iter = 0; iter < (x.fractional ? 0 : 5000); iter++) {
    let move: { i: number; qi: number; s: number } | null = null;
    for (const i of order) {
      const a = x.assets[i];
      const minLots = c.minTradeValue > 0 ? Math.max(1, Math.ceil(c.minTradeValue / (a.lot * (a.price as number)) - 1e-9)) : 1;
      const atStart = Math.abs(q[i] - q0[i]) < EPS;
      const candidates = [q[i] + a.lot, q[i] - a.lot, ...(atStart ? [q0[i] + minLots * a.lot, q0[i] - minLots * a.lot] : [])];
      // Moving back to "no trade" is always a candidate.
      candidates.push(q0[i]);
      for (const qi of candidates) {
        if (Math.abs(qi - q[i]) < EPS) continue;
        // A 0% target means exit: never add back (even if a small position would lower ex-ante TE).
        if (tgt[i] === 0 && qi > q[i]) continue;
        const old = q[i];
        q[i] = qi;
        if (feasible(q, i)) {
          const s = score(q);
          if (s < best - 1e-12 && (!move || s < move.s)) move = { i, qi, s };
        }
        q[i] = old;
      }
    }
    if (!move) break;
    q[move.i] = move.qi;
    best = move.s;
  }

  // Snap to the lot grid (repeated ± lot steps accumulate floating-point error).
  for (let i = 0; i < (x.fractional ? 0 : n); i++) {
    const lot = x.assets[i].lot;
    if (Math.abs(q[i]) > 1e-9) q[i] = Number((q0[i] + Math.round((q[i] - q0[i]) / lot) * lot).toFixed(10));
    else q[i] = 0; // full exit, odd lot included
  }
  const endCash = cashFor(q);
  const totAfter = q.reduce((s, qi, i) => s + qi * (x.assets[i].price ?? 0), 0) + endCash;
  const invAfter = totAfter - x.cashReserve;
  const trades: RebalanceTrade[] = x.assets.map((a, i) => {
    const dq = q[i] - q0[i];
    const value = dq * (a.price ?? 0);
    const side = Math.abs(dq) < EPS ? "hold" : dq > 0 ? "buy" : "sell";
    const finalWeight = invAfter > 0 ? (q[i] * (a.price ?? 0)) / invAfter : 0;
    let note: string | undefined;
    if (a.target == null) note = "ไม่ได้กำหนดเป้าหมาย — คงไว้";
    else if (!tradable[i]) note = "ไม่มีราคา";
    else if (frozen[i]) note = `อยู่ในช่วง ±${(x.noTradeBand * 100).toFixed(1)}% ของเป้าหมาย — ไม่ปรับ`;
    else if (side === "hold" && Math.abs(finalWeight - tgt[i]) > 0.005) note = "ปรับไม่ได้ภายใต้ lot / ขั้นต่ำ / เงินสด / ต้นทุน";
    return {
      symbol: a.symbol,
      side,
      quantity: Math.abs(dq),
      lots: Math.round(Math.abs(dq) / a.lot),
      price: a.price,
      value: Math.abs(value),
      cost: tradeCost(value, value >= 0 ? "buy" : "sell", c),
      currentQuantity: q0[i],
      finalQuantity: q[i],
      currentWeight: total > 0 ? ((a.price ?? 0) * q0[i]) / total : 0,
      targetWeight: a.target,
      finalWeight,
      note,
    };
  });
  const buy = trades.filter((t) => t.side === "buy").reduce((s, t) => s + t.value, 0);
  const sell = trades.filter((t) => t.side === "sell").reduce((s, t) => s + t.value, 0);
  const cost = trades.reduce((s, t) => s + t.cost.total, 0);
  if (endCash < x.cashReserve - 1e-6) violations.push("เงินสดติดลบหลังซื้อขาย");
  const gaps = trades.filter((t) => t.targetWeight != null && Math.abs(t.finalWeight - t.targetWeight) > 0.02).map((t) => t.symbol);
  if (gaps.length) warnings.push(`ห่างจากเป้าหมายเกิน 2%: ${gaps.join(", ")} (lot / ขั้นต่ำ / เงินสด / ต้นทุน / ช่วงไม่ปรับ)`);
  return {
    ok: violations.length === 0,
    proposalOnly: true,
    objective: x.objective,
    trades,
    totals: { buy, sell, cost, turnover: buy + sell, turnoverPct: total > 0 ? (buy + sell) / total : 0 },
    cash: { start: x.cash, extra: x.extraCash, reserve: x.cashReserve, end: endCash, targetWeight: Math.max(0, 1 - targetSum), finalWeight: invAfter > 0 ? (endCash - x.cashReserve) / invAfter : 0 },
    total: { before: holdingsValue + startCash, after: totAfter },
    distance: { measure: covOk ? "tracking_error" : "weight_gap", before, after: distance(q, endCash), continuousIdeal },
    violations,
    warnings,
  };
}
