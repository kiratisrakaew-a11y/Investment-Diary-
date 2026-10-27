/**
 * Dividend income plan / calendar (Strategies Phase 1). Pure; reads the ledger, never writes it.
 *
 * Status per expected payment:
 *  - received: matched to a ledger dividend transaction (the ledger amount is the actual money)
 *  - announced: a declared event whose payment is not yet due
 *  - missing_confirmation: due (payment date passed, or ex-date > 45 days ago without a payment
 *    date) but no matching ledger receipt
 *  - estimated: a forward estimate from last year's regular events (+12 months), only where no
 *    declared event exists for that period; uses the current holding
 * Entitlement = units held at the close before the ex-date (latest share basis) × DPS (latest basis).
 */
import { dpsLatestBasis, minusMonths, splitFactorAfter, type DividendEventInput, type SplitInput } from "./dividend-metrics";

export type IncomeStatus = "received" | "announced" | "missing_confirmation" | "estimated";

export interface IncomePosition {
  symbol: string;
  assetClass: string;
  currency: string;
  /** Units now (latest basis). */
  quantityNow: number;
  /** Units held at the end of a date, on the share basis of that date (ledger). */
  quantityAt: (date: string) => number;
}

export interface LedgerReceipt {
  id: number;
  symbol: string;
  date: string;
  amountThb: number;
}

export interface IncomeRow {
  symbol: string;
  status: IncomeStatus;
  exDate: string | null;
  paymentDate: string | null;
  /** Month bucket (payment date, else ex-date — flagged). */
  month: string;
  monthBasis: "payment_date" | "ex_date";
  units: number;
  dpsLatestBasis: number;
  currency: string;
  gross: number;
  withholdingRate: number;
  withholdingSource: string;
  net: number;
  fx: number | null;
  fxDate: string | null;
  netThb: number | null;
  receivedThb: number | null;
  receiptId: number | null;
  source: string;
  notes: string[];
}

const addDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);
const plusMonths = (iso: string, m: number) => minusMonths(iso, -m);

export function dividendIncomePlan(x: {
  today: string;
  horizonMonths: number;
  lookbackMonths: number;
  positions: IncomePosition[];
  events: DividendEventInput[];
  splits: Record<string, SplitInput[]>;
  receipts: LedgerReceipt[];
  /** Default withholding by asset class (assumption, editable). */
  withholding: Record<string, number>;
  /** THB per unit of currency as of a date (null when unknown). */
  fxAt: (currency: string, date: string) => { rate: number; date: string } | null;
}) {
  const rows: IncomeRow[] = [];
  const from = minusMonths(x.today, x.lookbackMonths);
  const to = plusMonths(x.today, x.horizonMonths);
  const used = new Set<number>();
  const gaps: string[] = [];
  const posBy = new Map(x.positions.map((p) => [p.symbol, p]));

  const build = (p: IncomePosition, e: DividendEventInput, status: IncomeStatus, notes: string[]): IncomeRow | null => {
    const splits = x.splits[p.symbol] ?? [];
    const dps = dpsLatestBasis(e, splits);
    let units: number;
    if (e.exDate && e.exDate <= x.today) {
      // Held at the close before the ex-date, converted to the latest basis.
      const before = addDays(e.exDate, -1);
      units = p.quantityAt(before) * splitFactorAfter(e.exDate, splits);
    } else {
      units = p.quantityNow;
      notes.push("สมมติถือจำนวนเท่าปัจจุบันจนถึง ex-date");
    }
    if (!(units > 0)) return null;
    const gross = units * dps;
    const wRate = e.withholdingTaxRate ?? x.withholding[p.assetClass] ?? 0;
    const wSrc = e.withholdingTaxRate != null ? "ข้อมูลเหตุการณ์" : x.withholding[p.assetClass] != null ? `สมมติฐานตามประเภท ${p.assetClass}` : "ไม่ได้ระบุ (0)";
    const net = gross * (1 - wRate);
    const fxDate = e.paymentDate ?? e.exDate ?? x.today;
    const fx = e.currency === "THB" ? { rate: 1, date: fxDate } : x.fxAt(e.currency, fxDate > x.today ? x.today : fxDate);
    if (!fx) notes.push(`ไม่มีอัตราแลกเปลี่ยน ${e.currency}`);
    const monthDate = e.paymentDate ?? e.exDate!;
    return {
      symbol: p.symbol,
      status,
      exDate: e.exDate,
      paymentDate: e.paymentDate,
      month: monthDate.slice(0, 7),
      monthBasis: e.paymentDate ? "payment_date" : "ex_date",
      units,
      dpsLatestBasis: dps,
      currency: e.currency,
      gross,
      withholdingRate: wRate,
      withholdingSource: wSrc,
      net,
      fx: fx?.rate ?? null,
      fxDate: fx?.date ?? null,
      netThb: fx ? net * fx.rate : null,
      receivedThb: null,
      receiptId: null,
      source: e.source,
      notes: e.paymentDate ? notes : [...notes, "ไม่ทราบวันจ่าย — จัดเดือนตาม ex-date"],
    };
  };

  for (const p of x.positions) {
    const evs = x.events.filter((e) => e.symbol === p.symbol && e.kind !== "indicated_annual" && e.cashOrStock === "cash" && e.exDate);
    if (!evs.length) gaps.push(p.symbol);
    // Declared / historical events in the window.
    for (const e of evs) {
      const anchor = e.paymentDate ?? e.exDate!;
      if (anchor < from || anchor > to) continue;
      const due = e.paymentDate ? e.paymentDate <= x.today : e.exDate! <= addDays(x.today, -45);
      const row = build(p, e, due ? "missing_confirmation" : "announced", []);
      if (!row) continue;
      // Match a ledger receipt between the ex-date and 45 days after the payment (or ex) date.
      const lo = e.exDate!;
      const hi = addDays(anchor, 45);
      const match = x.receipts
        .filter((r) => r.symbol === p.symbol && !used.has(r.id) && r.date >= lo && r.date <= hi)
        .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(anchor)) - Math.abs(Date.parse(b.date) - Date.parse(anchor)))[0];
      if (match) {
        used.add(match.id);
        row.status = "received";
        row.receivedThb = match.amountThb;
        row.receiptId = match.id;
        if (row.netThb != null && Math.abs(match.amountThb - row.netThb) > Math.max(1, 0.02 * row.netThb)) row.notes.push(`ยอดรับจริง ${match.amountThb.toFixed(2)} ต่างจากที่คำนวณ ${row.netThb.toFixed(2)} บาท`);
      }
      rows.push(row);
    }
    // Forward estimates: last year's regular events shifted by 12 months, where nothing is declared nearby.
    for (const e of evs.filter((v) => v.kind !== "special")) {
      const nextEx = plusMonths(e.exDate!, 12);
      if (nextEx <= x.today || nextEx > to) continue;
      const declared = evs.some((d) => d !== e && d.exDate! > x.today && Math.abs(Date.parse(d.exDate!) - Date.parse(nextEx)) < 60 * 86_400_000);
      if (declared) continue;
      const est: DividendEventInput = { ...e, exDate: nextEx, paymentDate: e.paymentDate ? plusMonths(e.paymentDate, 12) : null, announcedAt: null, source: `ประมาณการจาก ${e.source} ${e.exDate}` };
      const row = build(p, est, "estimated", ["ประมาณการจากปันผลปกติปีก่อน — ไม่ใช่การประกาศ"]);
      if (row) rows.push(row);
    }
  }
  // Ledger receipts with no event: still real money received.
  const unmatched = x.receipts.filter((r) => !used.has(r.id) && r.date >= from && r.date <= x.today && posBy.has(r.symbol));
  rows.sort((a, b) => a.month.localeCompare(b.month) || a.symbol.localeCompare(b.symbol));

  const sumBy = (key: (r: IncomeRow) => string) => {
    const m = new Map<string, Record<IncomeStatus, number>>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { received: 0, announced: 0, missing_confirmation: 0, estimated: 0 };
      cur[r.status] += r.status === "received" ? (r.receivedThb ?? 0) : (r.netThb ?? 0);
      m.set(k, cur);
    }
    for (const u of unmatched) {
      const k = key({ month: u.date.slice(0, 7) } as IncomeRow);
      const cur = m.get(k) ?? { received: 0, announced: 0, missing_confirmation: 0, estimated: 0 };
      cur.received += u.amountThb;
      m.set(k, cur);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, v]) => ({ period, ...v }));
  };
  const quarter = (r: IncomeRow) => `${r.month.slice(0, 4)}-Q${Math.ceil(Number(r.month.slice(5, 7)) / 3)}`;
  return {
    asOf: x.today,
    window: { from, to },
    rows,
    unmatchedReceipts: unmatched,
    byMonth: sumBy((r) => r.month),
    byQuarter: sumBy(quarter),
    byYear: sumBy((r) => r.month.slice(0, 4)),
    coverageGaps: gaps,
    methodology: [
      "สิทธิ์ = จำนวนหุ้นที่ถือ ณ สิ้นวันก่อน ex-date (ฐานหุ้นล่าสุด) × ปันผลต่อหุ้น (ฐานหุ้นล่าสุด)",
      "เงินที่ได้รับจริงอ้างอิงรายการ dividend ในบัญชี (ledger) เท่านั้น — ระบบไม่สร้างรายการรับปันผลให้อัตโนมัติ",
      "ประมาณการ = ปันผลปกติของปีก่อนเลื่อน 12 เดือน × จำนวนหุ้นปัจจุบัน (ไม่ใช่การประกาศ)",
      "ภาษีหัก ณ ที่จ่าย: ใช้อัตราในข้อมูลเหตุการณ์ ถ้าไม่มีใช้สมมติฐานตามประเภทสินทรัพย์ (แก้ได้)",
    ],
  };
}
