/**
 * Bond ladder (Strategies Phase 4). Pure; reuses the bond engine (`analyticsFromPrice`, cashflow
 * schedule), the credit model (`survivalFunction`) and XIRR — no second pricing or credit engine.
 *
 * Buckets: rung k holds bonds with years to maturity in (k − 1, k] (0.01-year tolerance). Each rung gets budget ÷ rungs,
 * split equally across the eligible bonds in it, then issuer caps; purchases are whole units at the
 * dirty price (clean + accrued). Empty rungs stay in cash and are reported. Output is a forward
 * cashflow scenario (coupon vs principal by year), not a historical backtest.
 */
import { analyticsFromPrice, type BondSpec } from "./bonds";
import { survivalFunction, type CreditProfile } from "./credit-risk";
import { capWeights } from "./dividend-strategies";
import { xirrDetailed } from "./returns";

export interface LadderCandidate {
  symbol: string;
  issuer: string | null;
  /** Face value per unit (currency). */
  faceValue: number;
  /** Clean price per 100 face. */
  cleanPer100: number;
  spec: BondSpec;
  credit: CreditProfile | null;
  priceDate: string;
}

export interface LadderSettings {
  budget: number;
  rungs: number;
  maxPerIssuer: number | null;
  /** Exclude bonds whose 1-year PD exceeds this (needs a PD in the credit profile). */
  maxOneYearPd: number | null;
  /** Lowest acceptable rating (same scale, e.g. "BBB+"); null = no rating filter. */
  minRating: string | null;
  allowUnrated: boolean;
  /** Assumed reinvestment rate for maturing principal and coupons (scenario only). */
  reinvestRate: number | null;
  maxPriceAgeDays: number;
}

const SCALE = ["AAA", "AA+", "AA", "AA-", "A+", "A", "A-", "BBB+", "BBB", "BBB-", "BB+", "BB", "BB-", "B+", "B", "B-", "CCC", "CC", "C", "D"];
export const ratingRank = (r: string | null | undefined) => {
  if (!r) return null;
  const i = SCALE.indexOf(r.trim().toUpperCase().replace(/\(.*\)$/, "").trim());
  return i < 0 ? null : i;
};

export interface LadderHolding {
  symbol: string;
  issuer: string | null;
  rung: number;
  yearsToMaturity: number;
  maturity: string;
  units: number;
  cleanPer100: number;
  dirtyPer100: number;
  accruedPaid: number;
  cost: number;
  face: number;
  ytm: number;
  modifiedDuration: number;
  dv01: number;
  rating: string | null;
  oneYearPd: number | null;
}

export function bondLadder(candidates: LadderCandidate[], s: LadderSettings, settlement: string) {
  const excluded: { symbol: string; code: string; detail: string }[] = [];
  const warnings: string[] = [];
  type Ok = { c: LadderCandidate; a: ReturnType<typeof analyticsFromPrice>; rung: number; pd1: number | null };
  const ok: Ok[] = [];
  for (const c of candidates) {
    const age = (Date.parse(settlement) - Date.parse(c.priceDate)) / 86_400_000;
    if (age > s.maxPriceAgeDays) {
      excluded.push({ symbol: c.symbol, code: "stale_price", detail: `ราคาล่าสุด ${c.priceDate} เก่ากว่า ${s.maxPriceAgeDays} วัน` });
      continue;
    }
    let a: ReturnType<typeof analyticsFromPrice>;
    try {
      a = analyticsFromPrice(c.spec, c.cleanPer100);
    } catch (e) {
      excluded.push({ symbol: c.symbol, code: "pricing_error", detail: (e as Error).message });
      continue;
    }
    // Day-count years of an exact N-year bond can be a hair above N (leap days): 0.01-year tolerance.
    const rung = Math.ceil(a.yearsToMaturity - 0.01);
    if (rung < 1 || rung > s.rungs) {
      excluded.push({ symbol: c.symbol, code: "outside_ladder", detail: `ครบกำหนดอีก ${a.yearsToMaturity.toFixed(2)} ปี — นอกช่วง 1–${s.rungs} ปี` });
      continue;
    }
    const rating = c.credit?.rating ?? null;
    let pd1: number | null = null;
    if (c.credit?.pd) {
      const sf = survivalFunction(c.credit.pd);
      if (sf.ok) pd1 = 1 - sf.S(1);
    }
    if (!rating && pd1 == null && !s.allowUnrated) {
      excluded.push({ symbol: c.symbol, code: "unrated", detail: "ไม่มีอันดับเครดิตหรือ PD (เปิด allowUnrated เพื่อรวม)" });
      continue;
    }
    if (s.minRating && rating) {
      const rr = ratingRank(rating);
      const mr = ratingRank(s.minRating);
      if (rr == null || mr == null) {
        excluded.push({ symbol: c.symbol, code: "unknown_rating_scale", detail: `อันดับ ${rating} อยู่นอกสเกลที่รู้จัก` });
        continue;
      }
      if (rr > mr) {
        excluded.push({ symbol: c.symbol, code: "below_min_rating", detail: `อันดับ ${rating} ต่ำกว่า ${s.minRating}` });
        continue;
      }
    }
    if (s.maxOneYearPd != null) {
      if (pd1 == null && !s.allowUnrated) {
        excluded.push({ symbol: c.symbol, code: "no_pd", detail: "ไม่มี PD ในโปรไฟล์เครดิต" });
        continue;
      }
      if (pd1 != null && pd1 > s.maxOneYearPd) {
        excluded.push({ symbol: c.symbol, code: "pd_above_max", detail: `PD 1 ปี ${(pd1 * 100).toFixed(2)}% > ${(s.maxOneYearPd * 100).toFixed(2)}%` });
        continue;
      }
    }
    ok.push({ c, a, rung, pd1 });
  }
  // Rung budgets → equal split inside each rung → issuer caps over the whole ladder.
  const per = s.budget / s.rungs;
  const gaps: number[] = [];
  const raw: Record<string, number> = {};
  for (let k = 1; k <= s.rungs; k++) {
    const inRung = ok.filter((o) => o.rung === k);
    if (!inRung.length) {
      gaps.push(k);
      continue;
    }
    for (const o of inRung) raw[o.c.symbol] = per / inRung.length / s.budget;
  }
  if (gaps.length) warnings.push(`ไม่มีพันธบัตรในขั้นปีที่ ${gaps.join(", ")} — เงินส่วนนั้นคงเป็นเงินสด (ไม่เกลี่ยไปขั้นอื่น)`);
  const filled = Object.values(raw).reduce((a, b) => a + b, 0);
  const groups: { name: string; members: string[]; cap: number }[] = [];
  if (s.maxPerIssuer != null) {
    const byIssuer = new Map<string, string[]>();
    for (const o of ok) if (raw[o.c.symbol] && o.c.issuer) byIssuer.set(o.c.issuer, [...(byIssuer.get(o.c.issuer) ?? []), o.c.symbol]);
    for (const [k, m] of byIssuer) groups.push({ name: k, members: m, cap: s.maxPerIssuer });
    const un = ok.filter((o) => raw[o.c.symbol] && !o.c.issuer).map((o) => o.c.symbol);
    if (un.length) warnings.push(`ยังไม่ระบุผู้ออก (ไม่อยู่ใต้เพดานผู้ออก): ${un.join(", ")}`);
  }
  // Scale to the filled share so capping does not move budget into empty rungs.
  const capped = filled > 0 ? capWeights(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / filled])), { maxWeight: 1, groups }) : { weights: {}, unallocated: 0, notes: [] };
  if (capped.unallocated > 1e-6) warnings.push(`เพดานผู้ออกทำให้ลงทุนได้น้อยลง ${(capped.unallocated * filled * 100).toFixed(1)}% ของงบ`);

  const holdings: LadderHolding[] = [];
  for (const o of ok) {
    const w = (capped.weights as Record<string, number>)[o.c.symbol];
    if (!w) continue;
    const alloc = w * filled * s.budget;
    const unitCost = (o.a.dirtyPrice / 100) * o.c.faceValue;
    const units = Math.floor(alloc / unitCost + 1e-9);
    if (units < 1) {
      warnings.push(`${o.c.symbol}: งบขั้นนี้ไม่พอซื้อ 1 หน่วย (หน่วยละ ${unitCost.toFixed(2)})`);
      continue;
    }
    holdings.push({
      symbol: o.c.symbol,
      issuer: o.c.issuer,
      rung: o.rung,
      yearsToMaturity: o.a.yearsToMaturity,
      maturity: o.c.spec.maturity,
      units,
      cleanPer100: o.a.cleanPrice,
      dirtyPer100: o.a.dirtyPrice,
      accruedPaid: (units * o.a.accruedInterest * o.c.faceValue) / 100,
      cost: units * unitCost,
      face: units * o.c.faceValue,
      ytm: o.a.ytm,
      modifiedDuration: o.a.modifiedDuration,
      dv01: (units * o.c.faceValue * o.a.dv01) / 100,
      rating: o.c.credit?.rating ?? null,
      oneYearPd: o.pd1,
    });
  }
  holdings.sort((a, b) => a.rung - b.rung || a.symbol.localeCompare(b.symbol));
  const invested = holdings.reduce((a, h) => a + h.cost, 0);
  const cash = s.budget - invested;

  // Cashflows by payment year: coupon vs principal (accrued bought is part of the first coupon).
  const byYear = new Map<string, { coupon: number; principal: number }>();
  const dated: { date: string; amount: number }[] = [{ date: settlement, amount: -invested }];
  for (const h of holdings) {
    const o = ok.find((v) => v.c.symbol === h.symbol)!;
    for (const f of o.a.flows) {
      const k = f.payDate.slice(0, 4);
      const scale = (h.units * o.c.faceValue) / 100;
      const cur = byYear.get(k) ?? { coupon: 0, principal: 0 };
      cur.coupon += f.coupon * scale;
      cur.principal += f.principal * scale;
      byYear.set(k, cur);
      dated.push({ date: f.payDate, amount: f.amount * scale });
    }
  }
  const years = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, v]) => ({ year, ...v, total: v.coupon + v.principal }));
  const irr = invested > 0 ? xirrDetailed(dated) : null;
  const duration = invested > 0 ? holdings.reduce((a, h) => a + h.modifiedDuration * h.cost, 0) / invested : null;
  // Reinvestment scenario: money received each year, and income it would earn at the assumed rate.
  const reinvestment =
    s.reinvestRate == null
      ? null
      : years.map((y) => ({ year: y.year, toReinvest: y.total, incomeNextYear: y.total * s.reinvestRate! }));
  return {
    settlement,
    rungs: Array.from({ length: s.rungs }, (_, i) => {
      const hs = holdings.filter((h) => h.rung === i + 1);
      return { rung: i + 1, holdings: hs.map((h) => h.symbol), cost: hs.reduce((a, h) => a + h.cost, 0), face: hs.reduce((a, h) => a + h.face, 0) };
    }),
    holdings,
    excluded,
    gaps,
    totals: { budget: s.budget, invested, cash, face: holdings.reduce((a, h) => a + h.face, 0), accruedPaid: holdings.reduce((a, h) => a + h.accruedPaid, 0), dv01: holdings.reduce((a, h) => a + h.dv01, 0) },
    portfolioYield: irr ? { rate: irr.rate, status: irr.status, method: "XIRR ของเงินลงทุน (ราคา dirty) และกระแสเงินสดตามตาราง ACT/365" } : null,
    weightedModifiedDuration: duration,
    cashflowsByYear: years,
    reinvestment,
    warnings,
    methodology: [
      "ขั้นที่ k = พันธบัตรที่ครบกำหนดใน (k − 1, k] ปี · งบต่อขั้น = งบรวม ÷ จำนวนขั้น แบ่งเท่ากันในขั้น แล้วใช้เพดานผู้ออก",
      "ซื้อเป็นหน่วยเต็มที่ราคา dirty (clean + ดอกเบี้ยค้างรับ) — ราคาที่เก็บถือเป็นราคา clean ตามหน้าพันธบัตร",
      "กระแสเงินสดจากตารางของ engine พันธบัตรเดิม (คูปองแยกจากเงินต้น) · YTM ≠ ผลตอบแทนที่เกิดจริง (ขึ้นกับการลงทุนต่อและการถือจนครบ)",
      "เป็นสถานการณ์ล่วงหน้า ไม่ใช่ backtest — แอปไม่มีราคาซื้อขายพันธบัตรย้อนหลังที่เชื่อถือได้",
    ],
  };
}
