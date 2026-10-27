/**
 * Portfolio accounting: positions, cash, and a daily valuation series in THB,
 * built purely from transactions + price history (no DB access here).
 *
 * Transaction conventions:
 *  - buy / sell: `quantity` units at `price` (asset currency), `fee` in asset currency.
 *  - dividend / coupon / deposit / withdraw / fee: `price` holds the total amount.
 *  - `fxRate` = THB per one unit of the asset currency (1 for THB).
 *  - Cash is a THB asset of the portfolio. Buys/sells are internal transfers;
 *    dividends/coupons are investment income; only deposits/withdrawals (and
 *    explicitly *inferred* flows, see below) are external cash flows.
 *  - Ordering: by date, then by entry sequence (transaction id).
 *
 * Integrity rules (remediation spec, Phase A):
 *  - Selling more than is held is rejected for new entries; in stored history
 *    only the held quantity is sold and proceeds are pro-rated (no inflated P&L).
 *  - A cash shortfall is rejected under the `strict` policy. Stored history is
 *    never rewritten: a shortfall becomes an explicit inferred external flow
 *    with a warning, so performance stays computable but is never silent.
 *  - Missing market prices / FX fall back to trade-date values only with a
 *    visible status and issue; FX is never assumed to be 1.
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

export type CashFlowPolicy = "strict" | "infer_with_warning";

export type IssueCode =
  | "OVERSELL"
  | "INSUFFICIENT_CASH"
  | "INVALID_TX"
  | "SPLIT_NO_HOLDING"
  | "DUPLICATE_TX"
  | "UNKNOWN_ASSET"
  | "STALE_PRICE"
  | "TX_PRICE_FALLBACK"
  | "MISSING_PRICE"
  | "STALE_FX"
  | "FX_FALLBACK";

export interface LedgerIssue {
  code: IssueCode;
  severity: "error" | "warning";
  date: string;
  symbol?: string;
  quantity?: number;
  amount?: number;
  message: string;
}

/** Thrown when a new transaction would break ledger integrity. */
export class LedgerError extends Error {
  constructor(public issue: LedgerIssue) {
    super(issue.message);
    this.name = "LedgerError";
  }
}

export type PriceStatus = "market" | "stale" | "tx_price_fallback" | "missing";
export type FxStatus = "market" | "stale" | "tx_fallback" | "not_applicable";

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
  priceStatus: PriceStatus;
  priceAgeDays: number | null;
  fxRate: number | null;
  fxStatus: FxStatus;
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

/** Maximum calendar days a price may be old before it is reported as stale. */
export const MAX_STALE_DAYS: Record<AssetClass, number> = {
  thai_stock: 7,
  us_stock: 7,
  gold: 7,
  fund: 10,
  bond: 30,
  cash: 100_000,
};
const MAX_STALE_FX_DAYS = 7;
const QTY_TOLERANCE = 1e-9;
const DAY_MS = 86_400_000;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

/** Index of the last entry on or before `date` (binary search), or -1. */
function asOfIndex(series: [string, number][] | undefined, date: string): number {
  if (!series || series.length === 0 || series[0][0] > date) return -1;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= date) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Last value on or before `date` from an ascending [date, value] series. */
export function asOf(series: [string, number][] | undefined, date: string): number | null {
  const i = asOfIndex(series, date);
  return i < 0 ? null : series![i][1];
}

/** Last [date, value] on or before `date`. */
export function asOfEntry(series: [string, number][] | undefined, date: string): [string, number] | null {
  const i = asOfIndex(series, date);
  return i < 0 ? null : series![i];
}

interface Lot {
  qty: number;
  costThb: number;
  realized: number;
  income: number;
  lastTxPrice: number;
  lastTxFx: number;
}

export interface InferredFlow {
  date: string;
  amount: number;
  reason: string;
}

interface State {
  lots: Map<number, Lot>;
  cash: number;
  /** Cumulative external contributions (THB), recorded + inferred. */
  netContributed: number;
  inferred: InferredFlow[];
  issues: LedgerIssue[];
}

const newState = (): State => ({ lots: new Map(), cash: 0, netContributed: 0, inferred: [], issues: [] });

/** Deterministic order: date, then entry sequence (id; transactions without id go last). */
export function sortTx(txs: TxInput[]): TxInput[] {
  return [...txs].sort((a, b) => a.date.localeCompare(b.date) || (a.id ?? Infinity) - (b.id ?? Infinity));
}

/** Drop repeated ids (e.g. a double import) and report them. */
function dedupe(txs: TxInput[], issues: LedgerIssue[]): TxInput[] {
  const seen = new Set<number>();
  const out: TxInput[] = [];
  for (const t of txs) {
    if (t.id != null) {
      if (seen.has(t.id)) {
        issues.push({ code: "DUPLICATE_TX", severity: "warning", date: t.date, message: `รายการ id ${t.id} ซ้ำ — นับครั้งเดียว` });
        continue;
      }
      seen.add(t.id);
    }
    out.push(t);
  }
  return out;
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/** Basic field validation (independent of ledger state). */
export function validateFields(tx: TxInput, symbol?: string): LedgerIssue | null {
  const bad = (message: string): LedgerIssue => ({ code: "INVALID_TX", severity: "error", date: tx.date, symbol, message });
  if (![tx.quantity, tx.price, tx.fee, tx.fxRate].every(Number.isFinite)) return bad("ตัวเลขในรายการไม่ถูกต้อง");
  if ((tx.type === "buy" || tx.type === "sell") && !(tx.quantity > 0)) return bad("จำนวนหน่วยต้องมากกว่า 0");
  if (tx.price < 0) return bad("ราคา/จำนวนเงินต้องไม่ติดลบ");
  if (tx.fee < 0) return bad("ค่าธรรมเนียมต้องไม่ติดลบ");
  if (!(tx.fxRate > 0)) return bad("อัตราแลกเปลี่ยนต้องมากกว่า 0");
  if (tx.type === "split" && !(tx.quantity > 0 && Math.abs(tx.quantity - 1) > 1e-12)) return bad("อัตราแตกพาร์ต้องมากกว่า 0 และไม่เท่ากับ 1");
  if ((tx.type === "buy" || tx.type === "sell" || tx.type === "dividend" || tx.type === "coupon" || tx.type === "split") && tx.assetId == null) {
    return bad("ต้องระบุสินทรัพย์สำหรับรายการประเภทนี้");
  }
  return null;
}

/**
 * Apply one transaction in replay mode (never throws); returns the external
 * flow (THB) it caused, recorded or inferred.
 */
function apply(state: State, tx: TxInput, symbols: Map<number, string>): { flow: number; inferred: number } {
  const symbol = tx.assetId != null ? symbols.get(tx.assetId) : undefined;
  const invalid = validateFields(tx, symbol);
  if (invalid) {
    state.issues.push({ ...invalid, severity: "warning", message: `${invalid.message} — ข้ามรายการนี้` });
    return { flow: 0, inferred: 0 };
  }
  const fx = tx.fxRate;
  let flow = 0;
  let inferred = 0;
  const lot = (id: number) => {
    let l = state.lots.get(id);
    if (!l) {
      l = { qty: 0, costThb: 0, realized: 0, income: 0, lastTxPrice: 0, lastTxFx: fx };
      state.lots.set(id, l);
    }
    return l;
  };
  const spend = (amount: number, what: string) => {
    const shortfall = amount - Math.max(0, state.cash);
    if (shortfall > 1e-6) {
      // Never silent: record the inferred external contribution and warn.
      state.cash += shortfall;
      flow += shortfall;
      inferred += shortfall;
      const reason = `เงินสดไม่พอสำหรับ${what} — อนุมานเงินฝากจากภายนอก ${fmt(shortfall)} บาท`;
      state.inferred.push({ date: tx.date, amount: shortfall, reason });
      state.issues.push({ code: "INSUFFICIENT_CASH", severity: "warning", date: tx.date, symbol, amount: shortfall, message: reason });
    }
    state.cash -= amount;
  };

  switch (tx.type) {
    case "deposit":
      state.cash += tx.price;
      flow += tx.price;
      break;
    case "withdraw":
      if (tx.price > state.cash + 1e-6) {
        state.issues.push({ code: "INSUFFICIENT_CASH", severity: "warning", date: tx.date, amount: tx.price, message: `ถอนเงิน ${fmt(tx.price)} มากกว่าเงินสดคงเหลือ ${fmt(state.cash)}` });
      }
      state.cash -= tx.price;
      flow -= tx.price;
      break;
    case "fee":
      spend(tx.price * fx, "ค่าธรรมเนียม");
      break;
    case "buy": {
      const l = lot(tx.assetId!);
      const cost = (tx.quantity * tx.price + tx.fee) * fx;
      spend(cost, `ซื้อ ${symbol ?? ""}`.trim());
      l.qty += tx.quantity;
      l.costThb += cost;
      l.lastTxPrice = tx.price;
      l.lastTxFx = fx;
      break;
    }
    case "sell": {
      const l = lot(tx.assetId!);
      let qty = tx.quantity;
      if (qty > l.qty + QTY_TOLERANCE) {
        state.issues.push({
          code: "OVERSELL",
          severity: "warning",
          date: tx.date,
          symbol,
          quantity: tx.quantity,
          message: `ขาย ${symbol ?? ""} ${fmt(tx.quantity)} หน่วย แต่ถืออยู่ ${fmt(l.qty)} — คำนวณเฉพาะส่วนที่ถืออยู่`,
        });
        qty = l.qty;
      }
      // Fees are pro-rated when only part of the order could be filled from holdings.
      const fee = tx.quantity > 0 ? tx.fee * (qty / tx.quantity) : 0;
      const avg = l.qty > 0 ? l.costThb / l.qty : 0;
      const proceeds = (qty * tx.price - fee) * fx;
      l.realized += proceeds - avg * qty;
      l.costThb -= avg * qty;
      l.qty -= qty;
      if (l.qty < QTY_TOLERANCE) {
        l.qty = 0;
        l.costThb = 0;
      }
      l.lastTxPrice = tx.price;
      l.lastTxFx = fx;
      state.cash += proceeds;
      break;
    }
    case "split": {
      // Corporate action: more (or fewer) shares, same total cost; no cash, no P&L.
      const l = lot(tx.assetId!);
      if (l.qty <= QTY_TOLERANCE) {
        state.issues.push({ code: "SPLIT_NO_HOLDING", severity: "warning", date: tx.date, symbol, message: `แตกพาร์ ${symbol ?? ""} แต่ไม่มีหุ้นถืออยู่ ณ วันที่ ${tx.date} — ไม่มีผลกับจำนวนหุ้น` });
      }
      l.qty *= tx.quantity;
      l.lastTxPrice = l.lastTxPrice / tx.quantity;
      break;
    }
    case "dividend":
    case "coupon": {
      const amt = tx.price * fx;
      lot(tx.assetId!).income += amt;
      state.cash += amt;
      break;
    }
  }
  state.netContributed += flow;
  return { flow, inferred };
}

function replay(assets: AssetInput[], txs: TxInput[], until?: string) {
  const state = newState();
  const symbols = new Map(assets.map((a) => [a.id, a.symbol]));
  for (const tx of sortTx(dedupe(txs, state.issues))) {
    if (until && tx.date > until) break;
    if (tx.assetId != null && !symbols.has(tx.assetId)) {
      state.issues.push({ code: "UNKNOWN_ASSET", severity: "warning", date: tx.date, message: `ไม่พบสินทรัพย์ id ${tx.assetId} — ข้ามรายการ` });
      continue;
    }
    apply(state, tx, symbols);
  }
  return state;
}

const issueKey = (i: LedgerIssue) => `${i.code}|${i.date}|${i.symbol ?? ""}|${i.quantity ?? ""}|${Math.round((i.amount ?? 0) * 100)}`;

/**
 * Check a new transaction against the stored ledger before saving it.
 * Throws `LedgerError` for invalid fields, oversells, and — under the strict
 * policy — any cash shortfall the new transaction introduces (also for
 * back-dated entries that break later rows). Legacy issues already present in
 * `existing` do not block new entries.
 */
export function validateNewTransaction(assets: AssetInput[], existing: TxInput[], tx: TxInput, policy: CashFlowPolicy): void {
  const symbol = tx.assetId != null ? assets.find((a) => a.id === tx.assetId)?.symbol : undefined;
  const invalid = validateFields(tx, symbol);
  if (invalid) throw new LedgerError(invalid);
  const before = new Set(replay(assets, existing).issues.map(issueKey));
  const after = replay(assets, [...existing, { ...tx, id: tx.id ?? Number.MAX_SAFE_INTEGER }]).issues;
  for (const i of after) {
    if (before.has(issueKey(i))) continue;
    if (i.code === "OVERSELL") {
      throw new LedgerError({ ...i, severity: "error", message: `${i.message.split(" — ")[0]} ณ วันที่ ${i.date} — ไม่อนุญาตให้ขายเกินจำนวนที่ถือ (ยังไม่รองรับ short selling)` });
    }
    if (i.code === "SPLIT_NO_HOLDING") throw new LedgerError({ ...i, severity: "error", message: `${i.message.split(" — ")[0]} — ตรวจวันที่หรือสินทรัพย์` });
    if (i.code === "INSUFFICIENT_CASH" && policy === "strict") {
      throw new LedgerError({
        ...i,
        severity: "error",
        message: `${i.message.split(" — ")[0]} ณ วันที่ ${i.date} — กรุณาบันทึก "ฝากเงิน" ก่อน หรือเปลี่ยนนโยบายเงินสดในหน้าตั้งค่า`,
      });
    }
  }
}

interface PriceInfo {
  price: number;
  priceDate: string | null;
  priceStatus: PriceStatus;
  priceAgeDays: number | null;
  fxRate: number | null;
  fxStatus: FxStatus;
}

function priceInfo(asset: AssetInput, l: Lot, date: string, prices: PriceHistory, fx: FxHistory): PriceInfo {
  const entry = asOfEntry(prices.get(asset.id), date);
  let price: number;
  let priceStatus: PriceStatus;
  let priceAgeDays: number | null = null;
  if (entry) {
    price = entry[1];
    priceAgeDays = daysBetween(entry[0], date);
    priceStatus = priceAgeDays > MAX_STALE_DAYS[asset.assetClass] ? "stale" : "market";
  } else if (l.lastTxPrice > 0) {
    price = l.lastTxPrice;
    priceStatus = "tx_price_fallback";
  } else {
    price = 0;
    priceStatus = "missing";
  }
  let fxRate: number | null = 1;
  let fxStatus: FxStatus = "not_applicable";
  if (asset.currency === "USD") {
    const f = asOfEntry(fx, date);
    if (f) {
      fxRate = f[1];
      fxStatus = daysBetween(f[0], date) > MAX_STALE_FX_DAYS ? "stale" : "market";
    } else {
      // Trade-date FX actually paid — never 1.
      fxRate = l.lastTxFx;
      fxStatus = "tx_fallback";
    }
  }
  return { price, priceDate: entry?.[0] ?? null, priceStatus, priceAgeDays, fxRate, fxStatus };
}

export interface Reconciliation {
  navThb: number;
  cashThb: number;
  positionsValueThb: number;
  /** NAV equals cash + Σ quantity × price × FX. */
  navMatches: boolean;
  /** Σ position weights + cash weight (100 when NAV > 0). */
  weightSumPct: number;
  recordedContributionsThb: number;
  inferredContributionsThb: number;
  status: "ok" | "warnings" | "errors";
}

export interface PortfolioSnapshot {
  positions: Position[];
  cashThb: number;
  totalValueThb: number;
  investedValueThb: number;
  netContributedThb: number;
  totalPnlThb: number;
  inferredFlows: InferredFlow[];
  issues: LedgerIssue[];
  reconciliation: Reconciliation;
}

export function buildSnapshot(assets: AssetInput[], txs: TxInput[], prices: PriceHistory, fx: FxHistory, date: string): PortfolioSnapshot {
  const state = replay(assets, txs, date);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const issues = [...state.issues];

  const positions: Position[] = [];
  for (const [assetId, l] of state.lots) {
    const a = byId.get(assetId);
    if (!a) continue;
    if (l.qty === 0 && l.realized === 0 && l.income === 0) continue;
    const info = priceInfo(a, l, date, prices, fx);
    if (l.qty > 0) {
      if (info.priceStatus === "stale")
        issues.push({ code: "STALE_PRICE", severity: "warning", date, symbol: a.symbol, message: `ราคา ${a.symbol} ล่าสุดเมื่อ ${info.priceDate} (${info.priceAgeDays} วัน) เก่ากว่าเกณฑ์ ${MAX_STALE_DAYS[a.assetClass]} วัน` });
      if (info.priceStatus === "tx_price_fallback")
        issues.push({ code: "TX_PRICE_FALLBACK", severity: "warning", date, symbol: a.symbol, message: `${a.symbol} ไม่มีราคาตลาด — ใช้ราคาจากรายการซื้อขายล่าสุด` });
      if (info.priceStatus === "missing")
        issues.push({ code: "MISSING_PRICE", severity: "error", date, symbol: a.symbol, message: `${a.symbol} ไม่มีราคา — มูลค่าเป็น 0 ในการคำนวณ` });
      if (info.fxStatus === "tx_fallback")
        issues.push({ code: "FX_FALLBACK", severity: "warning", date, symbol: a.symbol, message: `ไม่มีอัตรา USDTHB — ${a.symbol} ใช้อัตราแลกเปลี่ยน ณ วันซื้อขาย (${info.fxRate})` });
      if (info.fxStatus === "stale")
        issues.push({ code: "STALE_FX", severity: "warning", date, symbol: a.symbol, message: `อัตรา USDTHB ล่าสุดเก่ากว่า ${MAX_STALE_FX_DAYS} วัน` });
    }
    const mv = l.qty * info.price * (info.fxRate ?? 0);
    positions.push({
      assetId,
      symbol: a.symbol,
      name: a.name,
      assetClass: a.assetClass,
      currency: a.currency,
      quantity: l.qty,
      avgCostThb: l.qty > 0 ? l.costThb / l.qty : 0,
      costBasisThb: l.costThb,
      lastPrice: info.priceStatus === "missing" ? null : info.price,
      lastPriceDate: info.priceDate,
      priceStatus: info.priceStatus,
      priceAgeDays: info.priceAgeDays,
      fxRate: a.currency === "USD" ? info.fxRate : null,
      fxStatus: info.fxStatus,
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

  const inferredTotal = state.inferred.reduce((s, f) => s + f.amount, 0);
  const recompute = state.cash + positions.reduce((s, p) => s + p.quantity * (p.lastPrice ?? 0) * (p.currency === "USD" ? (p.fxRate ?? 0) : 1), 0);
  const weightSumPct = total > 0 ? positions.reduce((s, p) => s + p.weightPct, 0) + (state.cash / total) * 100 : 0;
  const status = issues.some((i) => i.severity === "error") ? "errors" : issues.length ? "warnings" : "ok";

  return {
    positions,
    cashThb: state.cash,
    totalValueThb: total,
    investedValueThb: invested,
    netContributedThb: state.netContributed,
    totalPnlThb: total - state.netContributed,
    inferredFlows: state.inferred,
    issues,
    reconciliation: {
      navThb: total,
      cashThb: state.cash,
      positionsValueThb: invested,
      navMatches: Math.abs(recompute - total) <= 1e-6 * Math.max(1, Math.abs(total)),
      weightSumPct,
      recordedContributionsThb: state.netContributed - inferredTotal,
      inferredContributionsThb: inferredTotal,
      status,
    },
  };
}

export type SeriesPoint = ValuePoint & {
  contributed: number;
  inferredFlow: number;
  /** Held positions valued with a price dated earlier than this date (carried / stale in the series). */
  carriedPositions: number;
};

/**
 * Daily valuation series (THB) on each date in `dates` (ascending), with the
 * external flow that occurred that day — the input for TWR. Inferred flows are
 * included in `flow` and also reported separately.
 */
export function buildValueSeries(assets: AssetInput[], txs: TxInput[], prices: PriceHistory, fx: FxHistory, dates: string[]): SeriesPoint[] {
  const state = newState();
  const sorted = sortTx(dedupe(txs, state.issues));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const symbols = new Map(assets.map((a) => [a.id, a.symbol]));
  let i = 0;
  const out: SeriesPoint[] = [];
  for (const d of dates) {
    let flow = 0;
    let inferred = 0;
    while (i < sorted.length && sorted[i].date <= d) {
      const tx = sorted[i++];
      if (tx.assetId != null && !byId.has(tx.assetId)) continue;
      const r = apply(state, tx, symbols);
      flow += r.flow;
      inferred += r.inferred;
    }
    let value = state.cash;
    let carried = 0;
    for (const [id, l] of state.lots) {
      const a = byId.get(id);
      if (a && l.qty > 0) {
        const info = priceInfo(a, l, d, prices, fx);
        value += l.qty * info.price * (info.fxRate ?? 0);
        if (a.assetClass !== "cash" && info.priceDate !== d) carried++;
      }
    }
    out.push({ date: d, value, flow, contributed: state.netContributed, inferredFlow: inferred, carriedPositions: carried });
  }
  return out;
}

/** External cash flows from the investor's point of view, for XIRR (inferred ones flagged). */
export function investorCashFlows(txs: TxInput[], assets?: AssetInput[]): { date: string; amount: number; inferred?: true }[] {
  const state = newState();
  const symbols = new Map((assets ?? []).map((a) => [a.id, a.symbol]));
  const out: { date: string; amount: number; inferred?: true }[] = [];
  for (const tx of sortTx(dedupe(txs, state.issues))) {
    const { flow, inferred } = apply(state, tx, symbols);
    const recorded = flow - inferred;
    if (recorded !== 0) out.push({ date: tx.date, amount: -recorded });
    if (inferred !== 0) out.push({ date: tx.date, amount: -inferred, inferred: true });
  }
  return out;
}
