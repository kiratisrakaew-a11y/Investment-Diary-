/**
 * Dividend metrics (Strategies Phase 1). Pure, as-of aware, no data invented.
 *
 * Share basis: stored prices are on the latest share basis (Yahoo closes are split-adjusted and
 * `adjustPricesForSplit` repairs older rows), so every per-share dividend is converted to the latest
 * basis too: `as_reported` amounts are divided by the product of split ratios effective after the
 * ex-date; `provider_split_adjusted` amounts are already on that basis. Yields are ratios, so they
 * are basis-invariant once both legs share a basis.
 *
 * Rates are decimals. Every result carries status, methodology, provenance, observations, warnings.
 */

export type MetricStatus = "available" | "partial" | "insufficient" | "not_meaningful" | "unavailable" | "unsupported";

export interface MetricResult {
  value: number | null;
  status: MetricStatus;
  methodology: string;
  asOf: string;
  provenance: string[];
  observations: number;
  warnings: string[];
  period?: string;
}

export type DividendKind = "regular" | "special" | "indicated_annual" | "unknown";

export interface DividendEventInput {
  id?: number;
  symbol: string;
  exDate: string | null;
  paymentDate: string | null;
  declarationDate?: string | null;
  recordDate?: string | null;
  announcedAt: string | null;
  dividendPerShare: number;
  currency: string;
  cashOrStock: "cash" | "stock";
  kind: DividendKind;
  splitAdjustmentPolicy: "as_reported" | "provider_split_adjusted";
  withholdingTaxRate: number | null;
  source: string;
}

/** Split effective on `date`: `ratio` new shares per old share. */
export interface SplitInput {
  date: string;
  ratio: number;
}

/** Fiscal-year fundamentals (millions of currency; per-share figures in currency units). */
export interface FundamentalsYear {
  fiscalYear: number;
  publishedAt?: string | null;
  /** Reporting currency of the statement row. */
  currency?: string | null;
  sharesOutstanding?: number | null;
  eps?: number | null;
  dps?: number | null;
  netIncome?: number | null;
  cfo?: number | null;
  capex?: number | null;
  dividendsPaid?: number | null;
  totalDebt?: number | null;
  cash?: number | null;
  ebitda?: number | null;
  ebit?: number | null;
  interestExpense?: number | null;
  totalEquity?: number | null;
  pretaxIncome?: number | null;
  incomeTax?: number | null;
}

const res = (asOf: string, status: MetricStatus, value: number | null, methodology: string, extra: Partial<MetricResult> = {}): MetricResult => ({
  value: status === "available" || status === "partial" ? value : null,
  status,
  methodology,
  asOf,
  provenance: [],
  observations: 0,
  warnings: [],
  ...extra,
});

const ok = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** asOf minus `months` calendar months (ISO date). */
export function minusMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** Product of split ratios effective strictly after `date` (and on/before `upTo` when given). */
export function splitFactorAfter(date: string, splits: SplitInput[], upTo?: string): number {
  return splits.filter((s) => s.date > date && (!upTo || s.date <= upTo)).reduce((f, s) => f * s.ratio, 1);
}

/** Dividend per share on the latest share basis. */
export function dpsLatestBasis(e: Pick<DividendEventInput, "dividendPerShare" | "splitAdjustmentPolicy" | "exDate">, splits: SplitInput[]): number {
  if (e.splitAdjustmentPolicy === "provider_split_adjusted" || !e.exDate) return e.dividendPerShare;
  return e.dividendPerShare / splitFactorAfter(e.exDate, splits);
}

/**
 * Events usable at a decision cutoff. An event with ex-date ≤ cutoff was necessarily public by then;
 * an event with a later ex-date counts only with an announcement date ≤ cutoff.
 */
export function eventsKnownBy(events: DividendEventInput[], cutoff: string): DividendEventInput[] {
  return events.filter((e) => (e.exDate != null && e.exDate <= cutoff) || (e.announcedAt != null && e.announcedAt <= cutoff));
}

/** Cash dividends with ex-date in (asOf − 12m, asOf], on the latest basis. */
function ttmEvents(events: DividendEventInput[], asOf: string) {
  const from = minusMonths(asOf, 12);
  return events.filter((e) => e.kind !== "indicated_annual" && e.exDate != null && e.exDate > from && e.exDate <= asOf);
}

export interface TtmYield {
  total: MetricResult;
  regular: MetricResult;
  dpsTotal: number | null;
  dpsRegular: number | null;
}

/** Trailing-12-month dividend yield = Σ DPS (ex-date in the window, latest basis) ÷ price at as-of. */
export function ttmDividendYield(x: { events: DividendEventInput[]; splits: SplitInput[]; asOf: string; price: number | null; priceCurrency: string; includeSpecial?: boolean }): TtmYield {
  const meth = "Σ เงินปันผลต่อหุ้น (ex-date ใน 12 เดือนก่อนวันอ้างอิง, ฐานหุ้นล่าสุด) ÷ ราคา ณ วันอ้างอิง";
  const none = (status: MetricStatus, w: string): TtmYield => {
    const r = res(x.asOf, status, null, meth, { warnings: [w] });
    return { total: r, regular: r, dpsTotal: null, dpsRegular: null };
  };
  if (!ok(x.price) || x.price <= 0) return none("unavailable", "ไม่มีราคา ณ วันอ้างอิง");
  const inWin = ttmEvents(x.events, x.asOf);
  const warnings: string[] = [];
  const mismatch = inWin.filter((e) => e.currency !== x.priceCurrency);
  if (mismatch.length) return none("unavailable", `สกุลเงินปันผล (${mismatch[0].currency}) ไม่ตรงกับราคา (${x.priceCurrency})`);
  const stock = inWin.filter((e) => e.cashOrStock === "stock");
  if (stock.length) warnings.push(`ไม่นับปันผลเป็นหุ้น ${stock.length} ครั้ง (ไม่ใช่เงินสด)`);
  const cash = inWin.filter((e) => e.cashOrStock === "cash");
  const unknown = cash.filter((e) => e.kind === "unknown");
  if (unknown.length) warnings.push(`${unknown.length} ครั้งไม่ทราบว่าเป็นปันผลปกติหรือพิเศษ (ผู้ให้ข้อมูลไม่ระบุ) — นับเป็นปกติ`);
  const missingEx = x.events.filter((e) => e.exDate == null && e.kind !== "indicated_annual").length;
  if (missingEx) warnings.push(`${missingEx} รายการไม่มี ex-date — ไม่นับ`);
  const sum = (es: DividendEventInput[]) => es.reduce((s, e) => s + dpsLatestBasis(e, x.splits), 0);
  const regularEvents = cash.filter((e) => e.kind !== "special");
  const special = cash.filter((e) => e.kind === "special");
  const dpsRegular = sum(regularEvents);
  const dpsTotal = sum(x.includeSpecial === false ? regularEvents : cash);
  const status: MetricStatus = unknown.length ? "partial" : "available";
  const prov = [...new Set(cash.map((e) => e.source))];
  const period = `${minusMonths(x.asOf, 12)} → ${x.asOf}`;
  return {
    total: res(x.asOf, status, dpsTotal / x.price, `${meth}${x.includeSpecial === false ? " (ไม่รวมปันผลพิเศษ)" : " (รวมปันผลพิเศษ)"}`, {
      provenance: prov,
      observations: x.includeSpecial === false ? regularEvents.length : cash.length,
      warnings: [...warnings, ...(special.length ? [`มีปันผลพิเศษ ${special.length} ครั้ง`] : [])],
      period,
    }),
    regular: res(x.asOf, status, dpsRegular / x.price, `${meth} (เฉพาะปันผลปกติ)`, { provenance: prov, observations: regularEvents.length, warnings, period }),
    dpsTotal,
    dpsRegular,
  };
}

/** Forward indicated yield: only from an explicitly declared annual rate (kind `indicated_annual`). */
export function forwardIndicatedYield(x: { events: DividendEventInput[]; splits: SplitInput[]; asOf: string; price: number | null }): MetricResult {
  const meth = "อัตราปันผลต่อปีที่บริษัทประกาศ (indicated) ÷ ราคาปัจจุบัน — เป็นการคาดการณ์ ไม่ใช่ผลตอบแทนที่เกิดขึ้นจริง";
  const declared = x.events
    .filter((e) => e.kind === "indicated_annual" && (e.announcedAt ?? e.declarationDate ?? null) != null && (e.announcedAt ?? e.declarationDate)! <= x.asOf)
    .sort((a, b) => ((a.announcedAt ?? a.declarationDate)! < (b.announcedAt ?? b.declarationDate)! ? 1 : -1));
  if (!declared.length) return res(x.asOf, "unavailable", null, meth, { warnings: ["ไม่มีอัตราปันผลต่อปีที่ประกาศไว้ — มีแต่ปันผลในอดีต จึงไม่คำนวณ forward yield"] });
  if (!ok(x.price) || x.price <= 0) return res(x.asOf, "unavailable", null, meth, { warnings: ["ไม่มีราคา"] });
  const e = declared[0];
  return res(x.asOf, "available", dpsLatestBasis(e, x.splits) / x.price, meth, { provenance: [e.source], observations: 1, warnings: ["เป็นการคาดการณ์จากอัตราที่ประกาศ"] });
}

const latestYear = (ys: FundamentalsYear[]) => [...ys].sort((a, b) => b.fiscalYear - a.fiscalYear)[0];

/** Earnings payout = DPS ÷ EPS (same fiscal year). EPS ≤ 0 → not_meaningful. */
export function earningsPayout(ys: FundamentalsYear[], asOf: string): MetricResult {
  const meth = "DPS ÷ EPS ของปีบัญชีเดียวกัน (EPS พื้นฐาน — ไม่มี diluted ในข้อมูล)";
  const y = latestYear(ys.filter((v) => ok(v.dps) || ok(v.eps) || ok(v.dividendsPaid)));
  if (!y) return res(asOf, "unavailable", null, meth, { warnings: ["ไม่มีงบการเงิน"] });
  const prov = [`งบปี ${y.fiscalYear}`];
  if (ok(y.dps) && ok(y.eps)) {
    if (y.eps <= 0) return res(asOf, "not_meaningful", null, meth, { provenance: prov, observations: 1, warnings: [`EPS ${y.eps} ≤ 0 — อัตราจ่ายไม่มีความหมาย (ไม่ใช่ข้อดี)`], period: `FY${y.fiscalYear}` });
    return res(asOf, "available", y.dps / y.eps, meth, { provenance: prov, observations: 1, period: `FY${y.fiscalYear}` });
  }
  if (ok(y.dividendsPaid) && ok(y.netIncome)) {
    if (y.netIncome <= 0) return res(asOf, "not_meaningful", null, meth, { provenance: prov, warnings: ["กำไรสุทธิ ≤ 0"], period: `FY${y.fiscalYear}` });
    return res(asOf, "partial", y.dividendsPaid / y.netIncome, "เงินปันผลจ่ายจริง ÷ กำไรสุทธิ (ใช้แทนเพราะไม่มี DPS/EPS)", {
      provenance: prov,
      observations: 1,
      warnings: ["เงินปันผลที่จ่ายในปีมักเป็นของกำไรปีก่อน — ช่วงเวลาไม่ตรงกันพอดี"],
      period: `FY${y.fiscalYear}`,
    });
  }
  return res(asOf, "unavailable", null, meth, { provenance: prov, warnings: [`FY${y.fiscalYear}: ไม่มี DPS/EPS (และไม่มีเงินปันผลจ่าย/กำไรสุทธิ)`] });
}

/** FCF = CFO − CapEx of the same fiscal year; null when either is missing. */
export function fcfOf(y: FundamentalsYear): number | null {
  return ok(y.cfo) && ok(y.capex) ? y.cfo - y.capex : null;
}

/** FCF payout = cash dividends paid ÷ (CFO − CapEx), same fiscal year. FCF ≤ 0 → not_meaningful + risk flag. */
export function fcfPayout(ys: FundamentalsYear[], asOf: string): MetricResult {
  const meth = "เงินปันผลจ่ายจริง ÷ (กระแสเงินสดจากการดำเนินงาน − รายจ่ายลงทุน) ปีบัญชีเดียวกัน";
  const y = latestYear(ys.filter((v) => ok(v.cfo) || ok(v.dividendsPaid)));
  if (!y) return res(asOf, "unavailable", null, meth, { warnings: ["ไม่มีงบกระแสเงินสด"] });
  const fcf = fcfOf(y);
  const prov = [`งบปี ${y.fiscalYear}`];
  const period = `FY${y.fiscalYear}`;
  if (fcf == null || !ok(y.dividendsPaid)) return res(asOf, "unavailable", null, meth, { provenance: prov, warnings: [`FY${y.fiscalYear}: ขาด ${[!ok(y.cfo) && "CFO", !ok(y.capex) && "CapEx", !ok(y.dividendsPaid) && "เงินปันผลจ่าย"].filter(Boolean).join(", ")}`], period });
  if (fcf <= 0) return res(asOf, "not_meaningful", null, meth, { provenance: prov, observations: 1, warnings: [`FCF ${fcf.toFixed(1)} ≤ 0 — จ่ายปันผลเกินกระแสเงินสดอิสระ (ความเสี่ยง)`], period });
  return res(asOf, "available", y.dividendsPaid / fcf, meth, { provenance: prov, observations: 1, period });
}

/** Coverage = earnings ÷ dividends (EPS/DPS) and FCF ÷ dividends paid, same period. */
export function dividendCoverage(ys: FundamentalsYear[], asOf: string): { earnings: MetricResult; fcf: MetricResult } {
  const y = latestYear(ys);
  const none = (m: string) => res(asOf, "unavailable", null, m, { warnings: ["ไม่มีงบการเงิน"] });
  if (!y) return { earnings: none("EPS ÷ DPS"), fcf: none("FCF ÷ เงินปันผลจ่าย") };
  const period = `FY${y.fiscalYear}`;
  const prov = [`งบปี ${y.fiscalYear}`];
  const earnings = !ok(y.eps) || !ok(y.dps)
    ? res(asOf, "unavailable", null, "EPS ÷ DPS", { provenance: prov, warnings: ["ไม่มี EPS หรือ DPS"], period })
    : y.dps <= 0
      ? res(asOf, "not_meaningful", null, "EPS ÷ DPS", { provenance: prov, warnings: ["ไม่จ่ายปันผลในปีนี้"], period })
      : res(asOf, "available", y.eps / y.dps, "EPS ÷ DPS", { provenance: prov, observations: 1, period });
  const f = fcfOf(y);
  const fcf = f == null || !ok(y.dividendsPaid)
    ? res(asOf, "unavailable", null, "FCF ÷ เงินปันผลจ่าย", { provenance: prov, warnings: ["ไม่มี CFO/CapEx หรือเงินปันผลจ่าย"], period })
    : y.dividendsPaid <= 0
      ? res(asOf, "not_meaningful", null, "FCF ÷ เงินปันผลจ่าย", { provenance: prov, warnings: ["ไม่จ่ายปันผลในปีนี้"], period })
      : res(asOf, "available", f / y.dividendsPaid, "FCF ÷ เงินปันผลจ่าย", { provenance: prov, observations: 1, period, warnings: f <= 0 ? ["FCF ≤ 0"] : [] });
  return { earnings, fcf };
}

export interface AnnualDps {
  year: number;
  dps: number;
}

/**
 * Annual DPS series: fiscal-year DPS from statements when at least two years exist; otherwise
 * calendar-year sums of regular cash dividends (latest basis) for complete years before the as-of year.
 */
export function annualDpsSeries(x: { statements: FundamentalsYear[]; events: DividendEventInput[]; splits: SplitInput[]; asOf: string }): { series: AnnualDps[]; source: "statements" | "events" | "none"; note: string } {
  const st = x.statements.filter((y) => ok(y.dps)).map((y) => ({ year: y.fiscalYear, dps: y.dps! })).sort((a, b) => a.year - b.year);
  if (st.length >= 2) return { series: st, source: "statements", note: "DPS ตามปีบัญชีจากงบการเงิน (อาจรวมปันผลพิเศษ — งบไม่แยก)" };
  const asOfYear = Number(x.asOf.slice(0, 4));
  const byYear = new Map<number, number>();
  for (const e of x.events) {
    if (e.kind === "special" || e.kind === "indicated_annual" || e.cashOrStock !== "cash" || !e.exDate || e.exDate > x.asOf) continue;
    const y = Number(e.exDate.slice(0, 4));
    if (y >= asOfYear) continue;
    byYear.set(y, (byYear.get(y) ?? 0) + dpsLatestBasis(e, x.splits));
  }
  if (!byYear.size) return { series: [], source: "none", note: "ไม่มีประวัติปันผล" };
  const first = Math.min(...byYear.keys());
  const series: AnnualDps[] = [];
  // Inside the event history a year without any event is a year without a dividend.
  for (let y = first; y < asOfYear; y++) series.push({ year: y, dps: byYear.get(y) ?? 0 });
  return { series, source: "events", note: "ผลรวมปันผลปกติตามปีปฏิทินของ ex-date (ฐานหุ้นล่าสุด) เฉพาะปีที่จบแล้ว" };
}

/** DPS CAGR over exactly `years` years: (DPS_end ÷ DPS_start)^(1/years) − 1, both positive. */
export function dpsCagr(series: AnnualDps[], years: number, asOf: string, source = ""): MetricResult {
  const meth = `(DPS ปีล่าสุด ÷ DPS ${years} ปีก่อน)^(1/${years}) − 1`;
  if (!series.length) return res(asOf, "insufficient", null, meth, { warnings: ["ไม่มีประวัติ DPS"] });
  const end = series[series.length - 1];
  const start = series.find((s) => s.year === end.year - years);
  if (!start) return res(asOf, "insufficient", null, meth, { warnings: [`ไม่มี DPS ปี ${end.year - years} (ต้องมีประวัติครบ ${years} ปี)`], observations: series.length });
  if (!(start.dps > 0) || !(end.dps > 0)) return res(asOf, "not_meaningful", null, meth, { warnings: [`DPS ต้นหรือปลายช่วงไม่เป็นบวก (${start.dps} → ${end.dps})`], period: `${start.year}–${end.year}` });
  return res(asOf, "available", (end.dps / start.dps) ** (1 / years) - 1, meth, { provenance: source ? [source] : [], observations: years + 1, period: `${start.year}–${end.year}` });
}

export interface Consistency {
  consecutiveYears: MetricResult;
  cuts: number;
  missedYears: number;
  historyYears: number;
}

/** Consecutive latest years with positive DPS, number of cuts and missed years (special excluded when known). */
export function dividendConsistency(series: AnnualDps[], asOf: string, source = ""): Consistency {
  const meth = "จำนวนปีติดต่อกันล่าสุดที่จ่ายปันผล > 0";
  if (!series.length) return { consecutiveYears: res(asOf, "insufficient", null, meth, { warnings: ["ไม่มีประวัติปันผล"] }), cuts: 0, missedYears: 0, historyYears: 0 };
  let streak = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].dps > 0 && (i === series.length - 1 || series[i + 1].year === series[i].year + 1)) streak++;
    else break;
  }
  let cuts = 0;
  let missed = 0;
  const gaps: number[] = [];
  for (let i = 0; i < series.length; i++) {
    if (!(series[i].dps > 0)) missed++;
    if (i > 0 && series[i].dps < series[i - 1].dps * (1 - 1e-9)) cuts++;
    if (i > 0 && series[i].year !== series[i - 1].year + 1) gaps.push(series[i - 1].year + 1);
  }
  const warnings = gaps.length ? [`ไม่มีข้อมูลปี ${gaps.join(", ")} (ไม่ถือว่าเป็น 0)`] : [];
  return {
    consecutiveYears: res(asOf, gaps.length ? "partial" : "available", streak, meth, { provenance: source ? [source] : [], observations: series.length, warnings, period: `${series[0].year}–${series[series.length - 1].year}` }),
    cuts,
    missedYears: missed,
    historyYears: series.length,
  };
}

/**
 * Current TTM yield against its own monthly history (percentile and z-score). Needs ≥ 24 monthly
 * observations. Flags a yield that is high mainly because the price fell ≥ 25% in 12 months.
 */
export function yieldVsHistory(x: { events: DividendEventInput[]; splits: SplitInput[]; asOf: string; prices: [string, number][]; priceCurrency: string; lookbackYears?: number; minObservations?: number }): MetricResult & { priceDropFlag: boolean } {
  const meth = "เปอร์เซ็นไทล์ของ TTM yield ปัจจุบันเทียบ TTM yield สิ้นเดือนย้อนหลัง";
  const min = x.minObservations ?? 24;
  const priceAt = (d: string) => {
    let v: number | null = null;
    for (const [pd, p] of x.prices) {
      if (pd > d) break;
      v = p;
    }
    return v;
  };
  const points: number[] = [];
  for (let m = 1; m <= (x.lookbackYears ?? 5) * 12; m++) {
    const d = minusMonths(x.asOf, m);
    const y = ttmDividendYield({ events: x.events, splits: x.splits, asOf: d, price: priceAt(d), priceCurrency: x.priceCurrency, includeSpecial: false });
    if (y.regular.value != null && x.prices.length && x.prices[0][0] <= minusMonths(d, 12)) points.push(y.regular.value);
  }
  const now = ttmDividendYield({ events: x.events, splits: x.splits, asOf: x.asOf, price: priceAt(x.asOf), priceCurrency: x.priceCurrency, includeSpecial: false }).regular.value;
  const p0 = priceAt(minusMonths(x.asOf, 12));
  const p1 = priceAt(x.asOf);
  const drop = p0 && p1 ? p1 / p0 - 1 : null;
  if (now == null || points.length < min) return { ...res(x.asOf, "insufficient", null, meth, { observations: points.length, warnings: [`ต้องมีอย่างน้อย ${min} เดือน (มี ${points.length})`] }), priceDropFlag: false };
  const below = points.filter((v) => v < now).length;
  const eq = points.filter((v) => v === now).length;
  const pct = (below + 0.5 * eq) / points.length;
  const priceDropFlag = drop != null && drop <= -0.25 && pct >= 0.8;
  return {
    ...res(x.asOf, "available", pct, meth, {
      observations: points.length,
      warnings: priceDropFlag ? [`yield สูงเพราะราคาลดลง ${(drop! * 100).toFixed(0)}% ใน 12 เดือน — ไม่นับเป็นข้อดี`] : [],
      period: `${points.length} เดือนย้อนหลัง`,
    }),
    priceDropFlag,
  };
}

/** Banks / insurers / finance: industrial leverage and FCF ratios do not apply. */
export function isFinancialSector(sector: string | null | undefined): boolean {
  return !!sector && /bank|insur|financ|ธนาคาร|ประกัน|การเงิน|เงินทุน|หลักทรัพย์/i.test(sector);
}

export interface QualityMetrics {
  roe: MetricResult;
  roic: MetricResult;
  netDebtToEbitda: MetricResult;
  interestCoverage: MetricResult;
  cfoToNetIncome: MetricResult;
  fcfStability: MetricResult;
  debtToEquity: MetricResult;
}

export function qualityMetrics(ys: FundamentalsYear[], asOf: string, sector?: string | null): QualityMetrics {
  const sorted = [...ys].sort((a, b) => a.fiscalYear - b.fiscalYear);
  const y = sorted[sorted.length - 1];
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const fin = isFinancialSector(sector);
  const none = (m: string) => res(asOf, "unavailable", null, m, { warnings: ["ไม่มีงบการเงิน"] });
  if (!y) {
    return {
      roe: none("ROE"),
      roic: none("ROIC"),
      netDebtToEbitda: none("Net debt ÷ EBITDA"),
      interestCoverage: none("EBIT ÷ ดอกเบี้ยจ่าย"),
      cfoToNetIncome: none("CFO ÷ กำไรสุทธิ"),
      fcfStability: none("ปีที่ FCF เป็นบวก"),
      debtToEquity: none("หนี้สินที่มีดอกเบี้ย ÷ ส่วนผู้ถือหุ้น"),
    };
  }
  const period = `FY${y.fiscalYear}`;
  const prov = [`งบปี ${y.fiscalYear}`];
  const ratio = (m: string, num: number | null | undefined, den: number | null | undefined, opts: { denPositive?: string; finNA?: boolean } = {}) => {
    if (opts.finNA && fin) return res(asOf, "not_meaningful", null, m, { provenance: prov, warnings: ["กลุ่มการเงิน — อัตราส่วนนี้ใช้กับธนาคาร/ประกันไม่ได้"], period });
    if (!ok(num) || !ok(den)) return res(asOf, "unavailable", null, m, { provenance: prov, warnings: ["ขาดข้อมูลในงบ"], period });
    if (den <= 0) return res(asOf, "not_meaningful", null, m, { provenance: prov, warnings: [opts.denPositive ?? "ตัวหาร ≤ 0"], period });
    return res(asOf, "available", num / den, m, { provenance: prov, observations: 1, period });
  };
  const avgEq = ok(y.totalEquity) && prev && ok(prev.totalEquity) ? (y.totalEquity + prev.totalEquity) / 2 : y.totalEquity;
  const roe = ratio("กำไรสุทธิ ÷ ส่วนผู้ถือหุ้นเฉลี่ย", y.netIncome, avgEq, { denPositive: "ส่วนผู้ถือหุ้น ≤ 0" });
  if (roe.status === "available" && !(prev && ok(prev.totalEquity))) {
    roe.status = "partial";
    roe.warnings.push("ใช้ส่วนผู้ถือหุ้นปลายปี (ไม่มีปีก่อน)");
  }
  const taxRate = ok(y.incomeTax) && ok(y.pretaxIncome) && y.pretaxIncome > 0 ? Math.min(Math.max(y.incomeTax / y.pretaxIncome, 0), 0.5) : null;
  const invested = ok(y.totalDebt) && ok(y.totalEquity) ? y.totalDebt + y.totalEquity - (ok(y.cash) ? y.cash : 0) : null;
  const roic = fin
    ? res(asOf, "not_meaningful", null, "ROIC", { provenance: prov, warnings: ["กลุ่มการเงิน — ใช้ ROE แทน"], period })
    : taxRate == null
    ? res(asOf, "unavailable", null, "EBIT × (1 − อัตราภาษี) ÷ (หนี้ + ส่วนผู้ถือหุ้น − เงินสด)", { provenance: prov, warnings: ["ไม่มีภาษี/กำไรก่อนภาษี"], period })
    : ratio("EBIT × (1 − อัตราภาษี) ÷ (หนี้ + ส่วนผู้ถือหุ้น − เงินสด)", ok(y.ebit) ? y.ebit * (1 - taxRate) : null, invested, { finNA: true });
  const netDebt = ok(y.totalDebt) && ok(y.cash) ? y.totalDebt - y.cash : null;
  const nde = ratio("(หนี้สินที่มีดอกเบี้ย − เงินสด) ÷ EBITDA", netDebt, y.ebitda, { denPositive: "EBITDA ≤ 0", finNA: true });
  let ic: MetricResult;
  if (fin) ic = res(asOf, "not_meaningful", null, "EBIT ÷ ดอกเบี้ยจ่าย", { provenance: prov, warnings: ["กลุ่มการเงิน — ดอกเบี้ยจ่ายเป็นต้นทุนธุรกิจหลัก"], period });
  else if (ok(y.interestExpense) && y.interestExpense === 0) ic = res(asOf, "not_meaningful", null, "EBIT ÷ ดอกเบี้ยจ่าย", { provenance: prov, warnings: ["ไม่มีดอกเบี้ยจ่าย"], period });
  else ic = ratio("EBIT ÷ ดอกเบี้ยจ่าย", y.ebit, y.interestExpense);
  const cfoNi = ratio("CFO ÷ กำไรสุทธิ", y.cfo, y.netIncome, { denPositive: "กำไรสุทธิ ≤ 0", finNA: true });
  const last5 = sorted.slice(-5).map(fcfOf).filter((v): v is number => v != null);
  const fcfStability = fin
    ? res(asOf, "not_meaningful", null, "สัดส่วนปีที่ FCF > 0 (5 ปีล่าสุด)", { warnings: ["กลุ่มการเงิน"], period })
    : last5.length < 3
      ? res(asOf, "insufficient", null, "สัดส่วนปีที่ FCF > 0 (5 ปีล่าสุด)", { observations: last5.length, warnings: ["ต้องมี CFO/CapEx อย่างน้อย 3 ปี"] })
      : res(asOf, "available", last5.filter((v) => v > 0).length / last5.length, "สัดส่วนปีที่ FCF > 0 (5 ปีล่าสุด)", { observations: last5.length, provenance: [`งบ ${last5.length} ปีล่าสุด`] });
  const de = ratio("หนี้สินที่มีดอกเบี้ย ÷ ส่วนผู้ถือหุ้น", y.totalDebt, y.totalEquity, { denPositive: "ส่วนผู้ถือหุ้น ≤ 0", finNA: true });
  return { roe, roic, netDebtToEbitda: nde, interestCoverage: ic, cfoToNetIncome: cfoNi, fcfStability, debtToEquity: de };
}

export interface DividendProfile {
  symbol: string;
  asOf: string;
  price: number | null;
  ttm: TtmYield;
  forward: MetricResult;
  earningsPayout: MetricResult;
  fcfPayout: MetricResult;
  coverage: { earnings: MetricResult; fcf: MetricResult };
  annual: { series: AnnualDps[]; source: string; note: string };
  cagr3: MetricResult;
  cagr5: MetricResult;
  cagr10: MetricResult;
  consistency: Consistency;
  yieldHistory: MetricResult & { priceDropFlag: boolean };
  quality: QualityMetrics;
  totalShareholderYield: MetricResult;
  financialSector: boolean;
  eventCount: number;
}

/** All metrics for one security as of a date, from inputs already filtered to what was known then. */
export function dividendProfile(x: {
  symbol: string;
  asOf: string;
  price: number | null;
  priceCurrency: string;
  prices?: [string, number][];
  events: DividendEventInput[];
  splits: SplitInput[];
  statements: FundamentalsYear[];
  sector?: string | null;
  includeSpecial?: boolean;
}): DividendProfile {
  const annual = annualDpsSeries({ statements: x.statements, events: x.events, splits: x.splits, asOf: x.asOf });
  const src = annual.source === "statements" ? "งบการเงิน" : annual.source === "events" ? "เหตุการณ์ปันผล" : "";
  return {
    symbol: x.symbol,
    asOf: x.asOf,
    price: x.price,
    ttm: ttmDividendYield({ events: x.events, splits: x.splits, asOf: x.asOf, price: x.price, priceCurrency: x.priceCurrency, includeSpecial: x.includeSpecial }),
    forward: forwardIndicatedYield({ events: x.events, splits: x.splits, asOf: x.asOf, price: x.price }),
    earningsPayout: earningsPayout(x.statements, x.asOf),
    fcfPayout: isFinancialSector(x.sector)
      ? res(x.asOf, "not_meaningful", null, "เงินปันผลจ่าย ÷ FCF", { warnings: ["กลุ่มการเงิน — FCF แบบอุตสาหกรรมใช้ไม่ได้"] })
      : fcfPayout(x.statements, x.asOf),
    coverage: dividendCoverage(x.statements, x.asOf),
    annual,
    cagr3: dpsCagr(annual.series, 3, x.asOf, src),
    cagr5: dpsCagr(annual.series, 5, x.asOf, src),
    cagr10: dpsCagr(annual.series, 10, x.asOf, src),
    consistency: dividendConsistency(annual.series, x.asOf, src),
    yieldHistory: x.prices?.length
      ? yieldVsHistory({ events: x.events, splits: x.splits, asOf: x.asOf, prices: x.prices, priceCurrency: x.priceCurrency })
      : { ...res(x.asOf, "insufficient", null, "เปอร์เซ็นไทล์ yield ย้อนหลัง", { warnings: ["ไม่มีประวัติราคา"] }), priceDropFlag: false },
    quality: qualityMetrics(x.statements, x.asOf, x.sector),
    totalShareholderYield: res(x.asOf, "unsupported", null, "Dividend yield + net buyback yield", { warnings: ["ไม่มีข้อมูลการซื้อหุ้นคืน — ไม่อนุมานจากราคา"] }),
    financialSector: isFinancialSector(x.sector),
    eventCount: x.events.length,
  };
}
