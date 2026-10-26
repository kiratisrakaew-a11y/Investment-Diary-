/**
 * Historical financial statements: standard line items, merging years from
 * several uploaded files, derived ratios, and turning a 5-year history into
 * valuation assumptions. Client-safe (used by the valuation editor).
 *
 * All monetary values are in millions of the reporting currency; shares in millions.
 */
import { z } from "zod";
import type { DcfAssumptions } from "./finance/valuation";

const n = (d: string) => z.number().nullable().describe(d);

export const lineItems = {
  // Income statement
  revenue: n("Total revenue / sales (รายได้รวม หรือ รายได้จากการขาย)"),
  cogs: n("Cost of sales (ต้นทุนขาย), positive number"),
  grossProfit: n("Gross profit (กำไรขั้นต้น)"),
  sga: n("Selling, general & administrative expenses, positive number"),
  ebitda: n("EBITDA, if reported or computable"),
  depreciation: n("Depreciation & amortisation (ค่าเสื่อมราคาและค่าตัดจำหน่าย), positive number"),
  ebit: n("Operating profit / EBIT (กำไรจากการดำเนินงาน ก่อนต้นทุนทางการเงินและภาษี)"),
  interestExpense: n("Finance costs / interest expense (ต้นทุนทางการเงิน), positive number"),
  pretaxIncome: n("Profit before income tax (กำไรก่อนภาษีเงินได้)"),
  incomeTax: n("Income tax expense (ภาษีเงินได้), positive number when an expense"),
  netIncome: n("Net profit attributable to owners of the parent (กำไรส่วนที่เป็นของผู้ถือหุ้นบริษัทใหญ่)"),
  eps: n("Basic earnings per share, in currency units (not millions)"),
  dps: n("Dividend per share declared for the year, in currency units (not millions)"),
  // Balance sheet
  cash: n("Cash, cash equivalents and short-term investments"),
  currentAssets: n("Total current assets"),
  totalAssets: n("Total assets"),
  currentLiabilities: n("Total current liabilities"),
  totalDebt: n("Interest-bearing debt: short- and long-term borrowings, debentures, lease liabilities"),
  totalEquity: n("Equity attributable to owners of the parent"),
  minorityInterest: n("Non-controlling interests (ส่วนได้เสียที่ไม่มีอำนาจควบคุม)"),
  sharesOutstanding: n("Ordinary shares outstanding"),
  // Cash flow
  cfo: n("Net cash from operating activities"),
  capex: n("Purchase of property, plant & equipment and intangibles, as a positive number"),
  dividendsPaid: n("Dividends paid to owners of the parent, as a positive number"),
};

export type LineItem = keyof typeof lineItems;
export const LINE_ITEMS = Object.keys(lineItems) as LineItem[];

export const financialYearSchema = z.object({
  fiscalYear: z.number().int().describe("Fiscal year, e.g. 2024 (convert Buddhist Era 2567 → 2024)"),
  ...lineItems,
});
export type FinancialYear = z.infer<typeof financialYearSchema>;

/**
 * What the AI returns for one uploaded file. Numbers are copied exactly as shown
 * in the source; unit conversion is done in code from the reported factors so
 * the model never has to do arithmetic on the figures.
 */
export const extractionSchema = z.object({
  companyName: z.string().nullable(),
  currency: z.string().describe("ISO currency code, e.g. THB"),
  unitInSource: z.string().describe("Monetary unit used in the source, e.g. 'พันบาท', 'Thousand Baht', 'ล้านบาท', 'Baht'"),
  moneyToMillions: z
    .number()
    .describe("Factor converting the source monetary unit to millions: Baht → 0.000001, thousand Baht → 0.001, million Baht → 1"),
  sharesToMillions: z
    .number()
    .describe("Factor converting the reported share count to millions of shares: shares → 0.000001, thousand shares → 0.001, million shares → 1"),
  statementBasis: z.enum(["consolidated", "separate", "unknown"]),
  years: z.array(financialYearSchema).describe("One entry per fiscal year found (including comparative columns), values exactly as in the source"),
  notes: z.string().describe("Where figures came from (pages / sheets), assumptions made, and anything uncertain"),
});
export type Extraction = z.infer<typeof extractionSchema>;

export const LINE_ITEM_LABEL: Record<LineItem, string> = {
  revenue: "รายได้",
  cogs: "ต้นทุนขาย",
  grossProfit: "กำไรขั้นต้น",
  sga: "ค่าใช้จ่ายขายและบริหาร",
  ebitda: "EBITDA",
  depreciation: "ค่าเสื่อมราคาและตัดจำหน่าย",
  ebit: "EBIT / กำไรจากการดำเนินงาน",
  interestExpense: "ต้นทุนทางการเงิน",
  pretaxIncome: "กำไรก่อนภาษี",
  incomeTax: "ภาษีเงินได้",
  netIncome: "กำไรสุทธิ (ส่วนบริษัทใหญ่)",
  eps: "EPS (บาท/หุ้น)",
  dps: "เงินปันผลต่อหุ้น (บาท)",
  cash: "เงินสดและเงินลงทุนระยะสั้น",
  currentAssets: "สินทรัพย์หมุนเวียน",
  totalAssets: "สินทรัพย์รวม",
  currentLiabilities: "หนี้สินหมุนเวียน",
  totalDebt: "หนี้สินที่มีภาระดอกเบี้ย",
  totalEquity: "ส่วนของผู้ถือหุ้นบริษัทใหญ่",
  minorityInterest: "ส่วนได้เสียที่ไม่มีอำนาจควบคุม",
  sharesOutstanding: "จำนวนหุ้น (ล้านหุ้น)",
  cfo: "กระแสเงินสดจากการดำเนินงาน",
  capex: "รายจ่ายลงทุน (Capex)",
  dividendsPaid: "เงินปันผลจ่าย",
};

export const LINE_ITEM_GROUPS: { title: string; items: LineItem[] }[] = [
  { title: "งบกำไรขาดทุน", items: ["revenue", "cogs", "grossProfit", "sga", "ebitda", "depreciation", "ebit", "interestExpense", "pretaxIncome", "incomeTax", "netIncome", "eps", "dps"] },
  { title: "งบฐานะการเงิน", items: ["cash", "currentAssets", "totalAssets", "currentLiabilities", "totalDebt", "totalEquity", "minorityInterest", "sharesOutstanding"] },
  { title: "งบกระแสเงินสด", items: ["cfo", "capex", "dividendsPaid"] },
];

/** Per-share items are not scaled by the unit multiplier. */
const PER_SHARE: LineItem[] = ["eps", "dps"];

export function emptyYear(fiscalYear: number): FinancialYear {
  return { fiscalYear, ...(Object.fromEntries(LINE_ITEMS.map((k) => [k, null])) as Record<LineItem, null>) };
}

/**
 * Convert source figures to millions. `moneyToMillions` is the factor for the
 * monetary unit (0.001 for thousands, 1e-6 for units); `sharesToMillions` the
 * same for the share count. Per-share items are left as reported.
 */
export function scaleYear(y: FinancialYear, moneyToMillions: number, sharesToMillions = moneyToMillions): FinancialYear {
  const out = { ...y };
  for (const k of LINE_ITEMS) {
    const v = y[k];
    if (v == null || PER_SHARE.includes(k)) continue;
    out[k] = v * (k === "sharesOutstanding" ? sharesToMillions : moneyToMillions);
  }
  return out;
}

/** Normalize an AI extraction to millions (guarding against implausible factors). */
export function normalizeExtraction(e: Extraction): FinancialYear[] {
  const ok = (f: number) => (Number.isFinite(f) && f > 0 && f <= 1000 ? f : 1);
  return e.years.map((y) => scaleYear(y, ok(e.moneyToMillions), ok(e.sharesToMillions)));
}

/**
 * Merge fiscal years from several files. For a year present in both, fields
 * from `incoming` win when non-null (`preferIncoming`), otherwise only gaps are filled.
 */
export function mergeYears(existing: FinancialYear[], incoming: FinancialYear[], preferIncoming = true): FinancialYear[] {
  const map = new Map(existing.map((y) => [y.fiscalYear, { ...y }]));
  for (const y of incoming) {
    const cur = map.get(y.fiscalYear);
    if (!cur) {
      map.set(y.fiscalYear, { ...emptyYear(y.fiscalYear), ...y });
      continue;
    }
    for (const k of LINE_ITEMS) {
      const v = y[k];
      if (v == null) continue;
      if (preferIncoming || cur[k] == null) cur[k] = v;
    }
  }
  return [...map.values()].sort((a, b) => a.fiscalYear - b.fiscalYear);
}

// ------------------------------------------------------------------ ratios

const div = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && b !== 0 ? a / b : null;

/** Fill common gaps from identities (EBIT from pretax + interest, EBITDA from EBIT + D&A, …). */
export function completeYear(y: FinancialYear): FinancialYear {
  const o = { ...y };
  if (o.grossProfit == null && o.revenue != null && o.cogs != null) o.grossProfit = o.revenue - o.cogs;
  if (o.ebit == null && o.pretaxIncome != null && o.interestExpense != null) o.ebit = o.pretaxIncome + o.interestExpense;
  if (o.ebitda == null && o.ebit != null && o.depreciation != null) o.ebitda = o.ebit + o.depreciation;
  if (o.eps == null && o.netIncome != null && o.sharesOutstanding) o.eps = o.netIncome / o.sharesOutstanding;
  return o;
}

export interface YearRatios {
  fiscalYear: number;
  revenueGrowth: number | null;
  grossMargin: number | null;
  ebitMargin: number | null;
  netMargin: number | null;
  daPct: number | null;
  capexPct: number | null;
  /** Operating NWC (current assets − cash − (current liabilities − short debt ≈ ignored)) as % of revenue. */
  nwcPct: number | null;
  effectiveTax: number | null;
  roe: number | null;
  payout: number | null;
  netDebt: number | null;
  bvps: number | null;
  costOfDebt: number | null;
}

export function deriveRatios(years: FinancialYear[]): YearRatios[] {
  const ys = [...years].sort((a, b) => a.fiscalYear - b.fiscalYear).map(completeYear);
  return ys.map((y, i) => {
    const prev = i > 0 ? ys[i - 1] : null;
    const nwc = y.currentAssets != null && y.currentLiabilities != null ? y.currentAssets - (y.cash ?? 0) - y.currentLiabilities : null;
    const avgEquity = prev?.totalEquity != null && y.totalEquity != null ? (prev.totalEquity + y.totalEquity) / 2 : y.totalEquity;
    const avgDebt = prev?.totalDebt != null && y.totalDebt != null ? (prev.totalDebt + y.totalDebt) / 2 : y.totalDebt;
    const payout = div(y.dividendsPaid, y.netIncome) ?? div(y.dps, y.eps);
    return {
      fiscalYear: y.fiscalYear,
      revenueGrowth: prev ? div((y.revenue ?? NaN) - (prev.revenue ?? NaN), prev.revenue) : null,
      grossMargin: div(y.grossProfit, y.revenue),
      ebitMargin: div(y.ebit, y.revenue),
      netMargin: div(y.netIncome, y.revenue),
      daPct: div(y.depreciation, y.revenue),
      capexPct: div(y.capex, y.revenue),
      nwcPct: div(nwc, y.revenue),
      effectiveTax: div(y.incomeTax, y.pretaxIncome),
      roe: div(y.netIncome, avgEquity),
      payout,
      netDebt: y.totalDebt != null ? y.totalDebt - (y.cash ?? 0) : null,
      bvps: div(y.totalEquity, y.sharesOutstanding),
      costOfDebt: div(y.interestExpense, avgDebt),
    };
  });
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
export const avg = (xs: (number | null | undefined)[]) => {
  const v = xs.filter(finite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Compound annual growth between the first and last year with positive revenue. */
export function revenueCagr(years: FinancialYear[]): number | null {
  const ys = [...years].filter((y) => finite(y.revenue) && (y.revenue as number) > 0).sort((a, b) => a.fiscalYear - b.fiscalYear);
  if (ys.length < 2) return null;
  const first = ys[0];
  const last = ys[ys.length - 1];
  const span = last.fiscalYear - first.fiscalYear;
  return span > 0 ? ((last.revenue as number) / (first.revenue as number)) ** (1 / span) - 1 : null;
}

export interface HistoryAssumptions {
  dcf: Partial<DcfAssumptions>;
  ddm: { d0?: number };
  ri: { bookValuePerShare?: number; roe?: number; payoutRatio?: number };
  multiples: { eps?: number; bookValuePerShare?: number; ebitda?: number; netDebt?: number; sharesOutstanding?: number };
  explanations: string[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const num = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Turn the last (up to) five fiscal years into starting valuation assumptions.
 * Averages smooth one-off years; outliers are clamped to sensible ranges.
 */
export function assumptionsFromHistory(years: FinancialYear[], terminalGrowth = 0.025): HistoryAssumptions {
  const sorted = [...years].sort((a, b) => a.fiscalYear - b.fiscalYear).map(completeYear);
  const last5 = sorted.slice(-5);
  const r5 = deriveRatios(last5);
  const r3 = r5.slice(-3);
  const latest = last5[last5.length - 1];
  const rl = r5[r5.length - 1];
  const out: HistoryAssumptions = { dcf: {}, ddm: {}, ri: {}, multiples: {}, explanations: [] };
  if (!latest) return out;
  const span = `${last5[0].fiscalYear}–${latest.fiscalYear}`;
  const say = (s: string) => out.explanations.push(s);

  if (finite(latest.revenue)) {
    out.dcf.revenue0 = latest.revenue;
    say(`รายได้ปีล่าสุด (${latest.fiscalYear}) = ${num(latest.revenue)}`);
  }
  const cagr = revenueCagr(last5);
  if (cagr != null) {
    const g = clamp(cagr, -0.1, 0.3);
    out.dcf.growthStart = g;
    out.dcf.growthEnd = (g + terminalGrowth) / 2;
    say(`Growth ปีแรก = CAGR รายได้ ${span} ${pct(cagr)}${g !== cagr ? ` (จำกัดเป็น ${pct(g)})` : ""}, ปีสุดท้ายลดลงครึ่งทางสู่ terminal growth`);
  }
  if (finite(rl?.ebitMargin)) {
    out.dcf.ebitMarginStart = rl.ebitMargin;
    const m5 = avg(r5.map((r) => r.ebitMargin));
    out.dcf.ebitMarginEnd = m5 ?? rl.ebitMargin;
    say(`EBIT margin: ปีแรก = ปีล่าสุด ${pct(rl.ebitMargin)}, ปีสุดท้าย = ค่าเฉลี่ย ${span} ${pct(out.dcf.ebitMarginEnd)}`);
  }
  const tax = avg(r5.map((r) => r.effectiveTax).filter((t) => t != null && t >= 0 && t <= 0.5));
  if (tax != null) {
    out.dcf.taxRate = clamp(tax, 0, 0.35);
    say(`อัตราภาษีที่แท้จริงเฉลี่ย ${pct(tax)}`);
  }
  const da = avg(r3.map((r) => r.daPct));
  if (da != null) {
    out.dcf.daPct = da;
    say(`D&A = ${pct(da)} ของรายได้ (เฉลี่ย 3 ปี)`);
  }
  const capex = avg(r3.map((r) => r.capexPct));
  if (capex != null) {
    out.dcf.capexPct = capex;
    say(`Capex = ${pct(capex)} ของรายได้ (เฉลี่ย 3 ปี)`);
  }
  const nwc = avg(r3.map((r) => r.nwcPct));
  if (nwc != null) {
    out.dcf.nwcPct = clamp(nwc, -0.3, 0.6);
    say(`Net working capital = ${pct(nwc)} ของรายได้ (เฉลี่ย 3 ปี)`);
  }
  if (finite(latest.totalDebt)) out.dcf.debt = latest.totalDebt;
  if (finite(latest.cash)) out.dcf.cash = latest.cash;
  if (finite(latest.minorityInterest)) out.dcf.otherClaims = latest.minorityInterest;
  if (finite(latest.sharesOutstanding)) out.dcf.sharesOutstanding = latest.sharesOutstanding;
  if (finite(latest.totalDebt) || finite(latest.cash)) say(`หนี้ ${num(latest.totalDebt ?? 0)}, เงินสด ${num(latest.cash ?? 0)}, minority ${num(latest.minorityInterest ?? 0)} ณ สิ้นปี ${latest.fiscalYear}`);
  const kd = avg(r3.map((r) => r.costOfDebt));
  if (kd != null) {
    out.dcf.costOfDebt = clamp(kd, 0.01, 0.15);
    say(`ต้นทุนหนี้ = ดอกเบี้ยจ่าย / หนี้เฉลี่ย ≈ ${pct(kd)}`);
  }

  if (finite(latest.dps)) {
    out.ddm.d0 = latest.dps;
    say(`เงินปันผลต่อหุ้นล่าสุด ${num(latest.dps)}`);
  }
  if (finite(rl?.bvps)) out.ri.bookValuePerShare = rl.bvps;
  const roe = avg(r3.map((r) => r.roe));
  if (roe != null) {
    out.ri.roe = roe;
    say(`ROE เฉลี่ย 3 ปี ${pct(roe)}`);
  }
  const payout = avg(r3.map((r) => r.payout).filter((p) => p != null && p >= 0 && p <= 1.5));
  if (payout != null) out.ri.payoutRatio = clamp(payout, 0, 1);

  if (finite(latest.eps)) out.multiples.eps = latest.eps;
  if (finite(rl?.bvps)) out.multiples.bookValuePerShare = rl.bvps;
  if (finite(latest.ebitda)) out.multiples.ebitda = latest.ebitda;
  if (finite(rl?.netDebt)) out.multiples.netDebt = rl.netDebt;
  if (finite(latest.sharesOutstanding)) out.multiples.sharesOutstanding = latest.sharesOutstanding;
  return out;
}
