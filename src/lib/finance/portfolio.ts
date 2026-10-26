/**
 * Portfolio accounting: positions, cash, and a daily valuation series in THB,
 * built purely from transactions + price history (no DB access here).
 *
 * Transaction conventions:
 *  - buy / sell: `quantity` units at `price` (asset currency), `fee` in asset currency.
 *  - dividend / coupon / deposit / withdraw / fee: `price` holds the total amount.
 *  - `fxRate` = THB per one unit of the asset currency (1 for THB).
 *  - Cash is held in THB. If a buy is not covered by recorded cash, an implicit
 *    deposit is assumed (the money came from outside the portfolio), so
 *    performance is still measured correctly when deposits are not logged.
 */
import type { AssetClass, TxType } from "@/db/schema";
import type { ValuePoint } from "./returns";

export interface TxInput {
  id?: number;
  date: string;
  assetId: number | null;
  type: TxType;
  quantity: number;
  price: number;
  fee: number;
  fxRate: number;
}

export interface AssetInput {
  id: number;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  currency: "THB" | "USD";
}

export interface Position {
  assetId: number;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  currency: "THB" | "USD";
  quantity: number;
  /** Average cost per unit in THB. */
  avgCostThb: number;
  costBasisThb: number;
  lastPrice: number | null;
  lastPriceDate: string | null;
  marketValueThb: number;
  unrealizedPnlThb: number;
  unrealizedPnlPct: number | null;
  realizedPnlThb: number;
  incomeThb: number;
  weightPct: number;
}

/** price lookup: asset id → ascending [date, close][] */
export type PriceHistory = Map<number, [string, number][]>;
/** ascending [date, USDTHB][] */
export type FxHistory = [string, number][];

/** Last value on or before `date` from an ascending [date, value] series (binary search). */
export function asOf(series: [string, number][] | undefined, date: string): number | null {
  if (!series || series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  if (series[0][0] > date) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= date) lo = mid;
    else hi = mid - 1;
  }
  return series[lo][1];
}

interface Lot {
  qty: number;
  costThb: number;
  realized: number;
  income: number;
  lastTxPrice: number;
  lastTxFx: number;
}

const ORDER: Record<TxType, number> = { deposit: 0, sell: 1, dividend: 2, coupon: 2, buy: 3, fee: 4, withdraw: 5 };

function sortTx(txs: TxInput[]): TxInput[] {
  return [...txs].sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.type] - ORDER[b.type] || (a.id ?? 0) - (b.id ?? 0));
}

interface State {
  lots: Map<number, Lot>;
  cash: number;
  /** Cumulative external contributions (THB), including implicit ones. */
  netContributed: number;
}

/** Apply one transaction; returns the external flow (THB) it caused. */
function apply(state: State, tx: TxInput): number {
  const fx = tx.fxRate || 1;
  let flow = 0;
  const lot = (id: number) => {
    let l = state.lots.get(id);
    if (!l) {
      l = { qty: 0, costThb: 0, realized: 0, income: 0, lastTxPrice: 0, lastTxFx: fx };
      state.lots.set(id, l);
    }
    return l;
  };
  const spend = (amount: number) => {
    if (state.cash < amount) {
      const injection = amount - Math.max(0, state.cash);
      state.cash += injection;
      flow += injection;
    }
    state.cash -= amount;
  };

  switch (tx.type) {
    case "deposit":
      state.cash += tx.price;
      flow += tx.price;
      break;
    case "withdraw":
      state.cash -= tx.price;
      flow -= tx.price;
      break;
    case "fee":
      spend(tx.price * fx);
      break;
    case "buy": {
      if (tx.assetId == null) break;
      const l = lot(tx.assetId);
      const cost = (tx.quantity * tx.price + tx.fee) * fx;
      spend(cost);
      l.qty += tx.quantity;
      l.costThb += cost;
      l.lastTxPrice = tx.price;
      l.lastTxFx = fx;
      break;
    }
    case "sell": {
      if (tx.assetId == null) break;
      const l = lot(tx.assetId);
      const qty = Math.min(tx.quantity, l.qty);
      const avg = l.qty > 0 ? l.costThb / l.qty : 0;
      const proceeds = (tx.quantity * tx.price - tx.fee) * fx;
      l.realized += proceeds - avg * qty;
      l.costThb -= avg * qty;
      l.qty -= qty;
      if (l.qty < 1e-9) {
        l.qty = 0;
        l.costThb = 0;
      }
      l.lastTxPrice = tx.price;
      l.lastTxFx = fx;
      state.cash += proceeds;
      break;
    }
    case "dividend":
    case "coupon": {
      const amt = tx.price * fx;
      if (tx.assetId != null) lot(tx.assetId).income += amt;
      state.cash += amt;
      break;
    }
  }
  state.netContributed += flow;
  return flow;
}

function priceThb(asset: AssetInput, l: Lot, date: string, prices: PriceHistory, fx: FxHistory) {
  const p = asOf(prices.get(asset.id), date) ?? l.lastTxPrice;
  const rate = asset.currency === "USD" ? (asOf(fx, date) ?? l.lastTxFx) : 1;
  return p * rate;
}

export interface PortfolioSnapshot {
  positions: Position[];
  cashThb: number;
  totalValueThb: number;
  investedValueThb: number;
  netContributedThb: number;
  totalPnlThb: number;
}

export function buildSnapshot(
  assets: AssetInput[],
  txs: TxInput[],
  prices: PriceHistory,
  fx: FxHistory,
  date: string,
): PortfolioSnapshot {
  const state: State = { lots: new Map(), cash: 0, netContributed: 0 };
  for (const tx of sortTx(txs)) if (tx.date <= date) apply(state, tx);
  const byId = new Map(assets.map((a) => [a.id, a]));

  const positions: Position[] = [];
  for (const [assetId, l] of state.lots) {
    const a = byId.get(assetId);
    if (!a) continue;
    if (l.qty === 0 && l.realized === 0 && l.income === 0) continue;
    const series = prices.get(assetId);
    const lastPrice = asOf(series, date);
    let lastPriceDate: string | null = null;
    if (series) for (const [d] of series) if (d <= date) lastPriceDate = d;
    const mv = l.qty * priceThb(a, l, date, prices, fx);
    positions.push({
      assetId,
      symbol: a.symbol,
      name: a.name,
      assetClass: a.assetClass,
      currency: a.currency,
      quantity: l.qty,
      avgCostThb: l.qty > 0 ? l.costThb / l.qty : 0,
      costBasisThb: l.costThb,
      lastPrice: lastPrice ?? (l.lastTxPrice || null),
      lastPriceDate,
      marketValueThb: mv,
      unrealizedPnlThb: mv - l.costThb,
      unrealizedPnlPct: l.costThb > 0 ? ((mv - l.costThb) / l.costThb) * 100 : null,
      realizedPnlThb: l.realized,
      incomeThb: l.income,
      weightPct: 0,
    });
  }
  const invested = positions.reduce((s, p) => s + p.marketValueThb, 0);
  const total = invested + state.cash;
  for (const p of positions) p.weightPct = total > 0 ? (p.marketValueThb / total) * 100 : 0;
  positions.sort((a, b) => b.marketValueThb - a.marketValueThb);

  return {
    positions,
    cashThb: state.cash,
    totalValueThb: total,
    investedValueThb: invested,
    netContributedThb: state.netContributed,
    totalPnlThb: total - state.netContributed,
  };
}

/**
 * Daily valuation series (THB) on each date in `dates` (ascending), with the
 * external flow that occurred that day — the input for TWR.
 */
export function buildValueSeries(
  assets: AssetInput[],
  txs: TxInput[],
  prices: PriceHistory,
  fx: FxHistory,
  dates: string[],
): (ValuePoint & { contributed: number })[] {
  const sorted = sortTx(txs);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const state: State = { lots: new Map(), cash: 0, netContributed: 0 };
  let i = 0;
  const out: (ValuePoint & { contributed: number })[] = [];
  for (const d of dates) {
    let flow = 0;
    while (i < sorted.length && sorted[i].date <= d) flow += apply(state, sorted[i++]);
    let value = state.cash;
    for (const [id, l] of state.lots) {
      const a = byId.get(id);
      if (a && l.qty > 0) value += l.qty * priceThb(a, l, d, prices, fx);
    }
    out.push({ date: d, value, flow, contributed: state.netContributed });
  }
  return out;
}

/** External cash flows from the investor's point of view, for XIRR. */
export function investorCashFlows(txs: TxInput[]): { date: string; amount: number }[] {
  const state: State = { lots: new Map(), cash: 0, netContributed: 0 };
  const out: { date: string; amount: number }[] = [];
  for (const tx of sortTx(txs)) {
    const f = apply(state, tx);
    if (f !== 0) out.push({ date: tx.date, amount: -f });
  }
  return out;
}
