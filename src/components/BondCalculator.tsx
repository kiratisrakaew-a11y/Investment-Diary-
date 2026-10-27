"use client";

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AreaGradient } from "./charts";
import {
  analyticsFromPrice,
  analyticsFromYield,
  discountBillPrice,
  discountBillYield,
  horizonReturn,
  keyRateDurations,
  priceChangeApprox,
  priceFromCurve,
  priceYieldCurve,
  yieldToWorst,
  zSpread,
  type BondSpec,
  type BusinessDayConvention,
  type CurvePoint,
  type DayCount,
} from "@/lib/finance/bonds";
import { NumField, SelectField } from "./fields";
import { fmtNum, fmtPct } from "@/lib/format";
import { CardTitle } from "./ExplainButton";
import { compact } from "@/lib/explain-data";

export interface BondCalcInit {
  maturity?: string;
  couponRate?: number;
  cleanPrice?: number;
  settlement: string;
}

export function BondCalculator({ init }: { init: BondCalcInit }) {
  const [settlement, setSettlement] = useState(init.settlement);
  const [maturity, setMaturity] = useState(init.maturity ?? "2031-06-15");
  const [coupon, setCoupon] = useState(init.couponRate ?? 0.03);
  const [freq, setFreq] = useState<"1" | "2" | "4" | "12">("2");
  const [mode, setMode] = useState<"price" | "yield">(init.cleanPrice != null ? "price" : "yield");
  const [price, setPrice] = useState(init.cleanPrice ?? 100);
  const [ytm, setYtm] = useState(0.028);
  const [calls, setCalls] = useState<{ date: string; price: number }[]>([]);
  const [shock, setShock] = useState(0.01);
  const [dayCount, setDayCount] = useState<DayCount>("ACT/ACT-ICMA");
  const [businessDay, setBusinessDay] = useState<BusinessDayConvention>("unadjusted");
  const [eom, setEom] = useState<"auto" | "yes" | "no">("auto");
  const [issueDate, setIssueDate] = useState("");
  const [firstCoupon, setFirstCoupon] = useState("");
  const [penultimate, setPenultimate] = useState("");
  const [exDays, setExDays] = useState(0);
  const [horizonDate, setHorizonDate] = useState("");
  const [reinvest, setReinvest] = useState(0.025);
  const [exitYield, setExitYield] = useState<number | null>(null);
  const [curveText, setCurveText] = useState("1: 2.0\n2: 2.1\n5: 2.4\n10: 2.8");
  const [issuer, setIssuer] = useState("");
  const [rating, setRating] = useState("");

  const spec: BondSpec = {
    settlement,
    maturity,
    couponRate: coupon,
    frequency: Number(freq) as 1 | 2 | 4 | 12,
    dayCount,
    businessDay,
    endOfMonth: eom === "auto" ? undefined : eom === "yes",
    issueDate: issueDate || undefined,
    firstCouponDate: firstCoupon || undefined,
    penultimateCouponDate: penultimate || undefined,
    exCouponDays: exDays || undefined,
  };
  const specKey = JSON.stringify(spec);
  const r = useMemo(() => {
    try {
      return { ok: true as const, a: mode === "price" ? analyticsFromPrice(spec, price) : analyticsFromYield(spec, ytm) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, mode, price, ytm]);
  const curve = useMemo(() => (r.ok ? priceYieldCurve(spec, r.a.ytm) : []), [r]); // eslint-disable-line react-hooks/exhaustive-deps
  const worst = useMemo(() => {
    const valid = calls.filter((c) => c.date > settlement && c.date < maturity && c.price > 0);
    if (!r.ok || !valid.length) return null;
    try {
      return yieldToWorst(spec, r.a.cleanPrice, valid);
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [r, calls]); // eslint-disable-line react-hooks/exhaustive-deps
  const horizon = useMemo(() => {
    if (!r.ok || !horizonDate) return null;
    try {
      return horizonReturn(spec, r.a.cleanPrice, { horizonDate, reinvestRate: reinvest, exitYield: exitYield ?? undefined });
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [r, horizonDate, reinvest, exitYield]); // eslint-disable-line react-hooks/exhaustive-deps
  const curveRes = useMemo(() => {
    if (!r.ok) return null;
    const pts: CurvePoint[] = curveText
      .split(/\n|;/)
      .map((l) => l.split(/[:\s,]+/).filter(Boolean).map(Number))
      .filter((x) => x.length === 2 && x.every(Number.isFinite) && x[0] > 0)
      .map(([years, rate]) => ({ years, rate: rate / 100 }));
    if (!pts.length) return null;
    try {
      const z = zSpread(spec, r.a.cleanPrice, pts);
      return { pts, curvePrice: priceFromCurve(spec, pts).cleanPrice, z, krd: keyRateDurations(spec, pts, z) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [r, curveText]); // eslint-disable-line react-hooks/exhaustive-deps

  const [billDays, setBillDays] = useState(91);
  const [billYield, setBillYield] = useState(0.019);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-5">
        <section className="card space-y-3 lg:col-span-2">
          <h2 className="text-[15px] font-semibold">ข้อมูลพันธบัตร / หุ้นกู้</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">วันชำระราคา</span>
              <input type="date" className="input" value={settlement} onChange={(e) => setSettlement(e.target.value)} />
            </label>
            <label className="block">
              <span className="label">วันครบกำหนด</span>
              <input type="date" className="input" value={maturity} onChange={(e) => setMaturity(e.target.value)} />
            </label>
            <NumField label="อัตราคูปอง" pct value={coupon} onChange={(v) => setCoupon(v ?? 0)} />
            <SelectField
              label="จ่ายดอกเบี้ย"
              value={freq}
              options={[
                { value: "1", label: "ปีละครั้ง" },
                { value: "2", label: "ทุก 6 เดือน" },
                { value: "4", label: "ทุกไตรมาส" },
                { value: "12", label: "ทุกเดือน" },
              ]}
              onChange={setFreq}
            />
            <SelectField
              label="คำนวณ"
              value={mode}
              options={[
                { value: "price", label: "ราคา → Yield (YTM)" },
                { value: "yield", label: "Yield → ราคา" },
              ]}
              onChange={setMode}
            />
            {mode === "price" ? (
              <NumField label="ราคา clean ต่อ 100" value={price} onChange={(v) => setPrice(v ?? 0)} />
            ) : (
              <NumField label="Yield to maturity" pct value={ytm} onChange={(v) => setYtm(v ?? 0)} />
            )}
          </div>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">เงื่อนไขตราสาร (day count, งวดแรก/สุดท้าย, ex-coupon)</summary>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <SelectField
                label="Day count (ดอกเบี้ยค้างรับ)"
                value={dayCount}
                options={[
                  { value: "ACT/ACT-ICMA", label: "ACT/ACT (ICMA)" },
                  { value: "ACT/365F", label: "ACT/365 Fixed" },
                  { value: "ACT/360", label: "ACT/360" },
                  { value: "30/360", label: "30/360" },
                ]}
                onChange={setDayCount}
              />
              <SelectField
                label="วันจ่ายตรงวันหยุด"
                value={businessDay}
                options={[
                  { value: "unadjusted", label: "ไม่เลื่อน" },
                  { value: "following", label: "เลื่อนไปวันทำการถัดไป" },
                  { value: "modified_following", label: "Modified following" },
                ]}
                onChange={setBusinessDay}
              />
              <SelectField
                label="คูปองสิ้นเดือน (EOM)"
                value={eom}
                options={[
                  { value: "auto", label: "อัตโนมัติ (ตามวันครบกำหนด)" },
                  { value: "yes", label: "ใช่" },
                  { value: "no", label: "ไม่ใช่" },
                ]}
                onChange={setEom}
              />
              <NumField label="Ex-coupon (วันก่อนจ่าย)" value={exDays} onChange={(v) => setExDays(Math.max(0, Math.round(v ?? 0)))} />
              <DateField label="วันออกตราสาร" value={issueDate} onChange={setIssueDate} />
              <DateField label="วันจ่ายคูปองแรก (ถ้าไม่ปกติ)" value={firstCoupon} onChange={setFirstCoupon} />
              <DateField label="วันจ่ายคูปองงวดรองสุดท้าย (ถ้างวดสุดท้ายไม่ปกติ)" value={penultimate} onChange={setPenultimate} />
            </div>
            <p className="mt-2 text-xs text-muted">ใช้เงื่อนไขตามหนังสือชี้ชวน/ThaiBMA ของตราสารนั้น · การเลื่อนวันจ่ายพิจารณาเฉพาะเสาร์–อาทิตย์ (ไม่รวมวันหยุดนักขัตฤกษ์) และไม่เปลี่ยนการคิดดอกเบี้ย</p>
          </details>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">สิทธิไถ่ถอนก่อนกำหนด (Yield to call / worst)</summary>
            <div className="mt-3 space-y-2">
              {calls.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <DateField label={`วันไถ่ถอน ${i + 1}`} value={c.date} onChange={(v) => setCalls((cs) => cs.map((x, j) => (j === i ? { ...x, date: v } : x)))} />
                  <NumField label="ราคาไถ่ถอน" value={c.price} onChange={(v) => setCalls((cs) => cs.map((x, j) => (j === i ? { ...x, price: v ?? 100 } : x)))} />
                  <button type="button" className="btn-ghost mb-1 text-xs" onClick={() => setCalls((cs) => cs.filter((_, j) => j !== i))}>
                    ลบ
                  </button>
                </div>
              ))}
              <button type="button" className="btn-ghost text-xs" onClick={() => setCalls((cs) => [...cs, { date: "", price: 100 }])}>
                + เพิ่มวันไถ่ถอน
              </button>
            </div>
          </details>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">ผู้ออก</span>
              <input className="input" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="เช่น กระทรวงการคลัง" />
            </label>
            <label className="block">
              <span className="label">อันดับเครดิต (สถาบัน, วันที่)</span>
              <input className="input" value={rating} onChange={(e) => setRating(e.target.value)} placeholder="เช่น AA- (TRIS, 2026-05)" />
            </label>
          </div>
        </section>

        <section className="card lg:col-span-3">
          <CardTitle title="ผลลัพธ์" explain={r.ok ? { data: compact({ พันธบัตร: spec, ราคา: price, ผลวิเคราะห์: { ...r.a, cashflows: undefined } }), hint: "YTM = ผลตอบแทนต่อปีถ้าถือจนครบกำหนด; duration = ราคาเปลี่ยนกี่ % เมื่อดอกเบี้ยเปลี่ยน 1%; convexity = ความโค้ง" } : null} />
          {!r.ok ? (
            <p className="text-sm text-neg">{r.error}</p>
          ) : (
            <div className="grid gap-x-8 sm:grid-cols-2">
              <div>
                <Row k="Yield to maturity" v={fmtPct(r.a.ytm, 3)} strong />
                <Row k="ราคา clean" v={fmtNum(r.a.cleanPrice, 4)} strong />
                <Row k="ดอกเบี้ยค้างรับ (accrued)" v={fmtNum(r.a.accruedInterest, 4)} />
                <Row k="ราคา dirty (ที่จ่ายจริง)" v={fmtNum(r.a.dirtyPrice, 4)} />
                <Row k="Current yield (คูปอง ÷ ราคา — ไม่ใช่ YTM)" v={fmtPct(r.a.currentYield, 3)} />
                {worst && "error" in worst && <p className="py-1 text-xs text-neg">{worst.error}</p>}
                {worst && !("error" in worst) && (
                  <>
                    {worst.candidates
                      .filter((c) => c.type === "call")
                      .map((c) => (
                        <Row key={c.date} k={`Yield to call ${c.date} @ ${fmtNum(c.price, 2)}`} v={fmtPct(c.yield, 3)} />
                      ))}
                    <Row k={`Yield to worst (${worst.worst.type === "maturity" ? "ครบกำหนด" : worst.worst.date})`} v={fmtPct(worst.yield, 3)} strong />
                  </>
                )}
                {(r.a.firstPeriod !== "regular" || r.a.lastPeriod !== "regular" || r.a.exCoupon) && (
                  <p className="py-1 text-xs text-muted">
                    {r.a.firstPeriod !== "regular" && `งวดแรก${r.a.firstPeriod === "short" ? "สั้น" : "ยาว"}กว่าปกติ · `}
                    {r.a.lastPeriod !== "regular" && `งวดสุดท้าย${r.a.lastPeriod === "short" ? "สั้น" : "ยาว"}กว่าปกติ · `}
                    {r.a.exCoupon && "อยู่ในช่วง ex-coupon: คูปองถัดไปเป็นของผู้ขาย (accrued ติดลบ)"}
                  </p>
                )}
              </div>
              <div>
                <Row k="อายุคงเหลือ" v={`${fmtNum(r.a.yearsToMaturity, 2)} ปี`} />
                <Row k="Macaulay duration" v={`${fmtNum(r.a.macaulayDuration, 3)} ปี`} />
                <Row k="Modified duration" v={fmtNum(r.a.modifiedDuration, 3)} />
                <Row k="Convexity" v={fmtNum(r.a.convexity, 2)} />
                <Row k="Effective duration / convexity (±1bp)" v={`${fmtNum(r.a.effectiveDuration, 3)} / ${fmtNum(r.a.effectiveConvexity, 2)}`} />
                <Row k="DV01 (ต่อ 100)" v={fmtNum(r.a.dv01, 4)} />
                <Row k="คูปองถัดไป" v={r.a.nextCoupon} />
              </div>
              <div className="mt-3 rounded-lg bg-bg p-3 text-sm sm:col-span-2">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-32">
                    <NumField label="Yield เปลี่ยน" pct value={shock} onChange={(v) => setShock(v ?? 0)} />
                  </div>
                  <div className="pb-2">
                    ราคาเปลี่ยนโดยประมาณ (duration + convexity):{" "}
                    <b>{fmtPct(priceChangeApprox(r.a.modifiedDuration, r.a.convexity, shock), 2)}</b> · คำนวณจริง:{" "}
                    <b>{fmtPct(analyticsFromYield(spec, r.a.ytm + shock).dirtyPrice / r.a.dirtyPrice - 1, 2)}</b>
                  </div>
                </div>
                <table className="mt-2 w-full text-xs">
                  <thead>
                    <tr className="text-muted">
                      <th className="text-left font-normal">Yield เปลี่ยน</th>
                      {r.a.scenarios.map((x) => (
                        <th key={x.shiftBp} className="text-right font-normal">
                          {x.shiftBp > 0 ? "+" : ""}
                          {x.shiftBp}bp
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>ราคา clean</td>
                      {r.a.scenarios.map((x) => (
                        <td key={x.shiftBp} className="text-right tabular-nums">{fmtNum(x.cleanPrice, 3)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td>เปลี่ยน (จริง / ประมาณ)</td>
                      {r.a.scenarios.map((x) => (
                        <td key={x.shiftBp} className="text-right tabular-nums">
                          {fmtPct(x.change, 2)} <span className="text-muted">/ {fmtPct(x.approx, 2)}</span>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted sm:col-span-2">
                {issuer || "ผู้ออกไม่ระบุ"} · {rating || "ไม่ระบุอันดับเครดิต"} — Yield รวมค่าชดเชยความเสี่ยงเครดิตและสภาพคล่อง ไม่ใช่ผลตอบแทนปลอดความเสี่ยง · day count {r.a.dayCount}
              </p>
            </div>
          )}
        </section>
      </div>

      {r.ok && (
        <div className="grid gap-6 lg:grid-cols-5">
          <section className="card lg:col-span-3">
            <h2 className="mb-3 font-semibold">Price–Yield curve (ความโค้ง = convexity)</h2>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={curve} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <AreaGradient id="gBondCurve" color="var(--series-1)" via="var(--series-5)" top={0.75} />
                </defs>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="ytm" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v) => `${(v * 100).toFixed(1)}%`} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis domain={["auto", "auto"]} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "var(--panel-solid)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" }}
                  formatter={(v) => [fmtNum(Number(v), 3), "ราคา clean"]}
                  labelFormatter={(v) => `YTM ${(Number(v) * 100).toFixed(2)}%`}
                />
                <Area type="monotone" dataKey="price" stroke="var(--series-1)" fill="url(#gBondCurve)" baseValue="dataMin" strokeWidth={2} isAnimationActive={false} />
                <ReferenceDot x={r.a.ytm} y={r.a.cleanPrice} r={6} fill="var(--series-2)" stroke="var(--panel-solid)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </section>
          <section className="card overflow-x-auto lg:col-span-2">
            <h2 className="mb-3 font-semibold">กระแสเงินสดคงเหลือ (ต่อ 100)</h2>
            <div className="max-h-64 overflow-y-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th className="num">จำนวน</th>
                    <th className="num">PV</th>
                  </tr>
                </thead>
                <tbody>
                  {r.a.flows.map((f) => (
                    <tr key={f.date}>
                      <td>
                        {f.date}
                        {f.payDate !== f.date && <span className="block text-[11px] text-muted">จ่ายจริง {f.payDate}</span>}
                      </td>
                      <td className="num">{fmtNum(f.amount, 3)}</td>
                      <td className="num">{fmtNum(f.amount / (1 + r.a.ytm / spec.frequency) ** f.periods, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {r.ok && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card space-y-3">
            <h2 className="text-[15px] font-semibold">ผลตอบแทนจริงถ้าขายก่อนครบกำหนด (horizon return)</h2>
            <div className="grid grid-cols-3 gap-3">
              <DateField label="วันที่ขาย" value={horizonDate} onChange={setHorizonDate} />
              <NumField label="ลงทุนต่อคูปองที่" pct value={reinvest} onChange={(v) => setReinvest(v ?? 0)} />
              <NumField label="Yield ตอนขาย" pct nullable value={exitYield} onChange={setExitYield} hint="เว้นว่าง = YTM ปัจจุบัน" />
            </div>
            {horizon && "error" in horizon && <p className="text-sm text-neg">{horizon.error}</p>}
            {horizon && !("error" in horizon) && (
              <div>
                <Row k="เงินลงทุน (dirty)" v={fmtNum(horizon.initialDirty, 3)} />
                <Row k="คูปอง + ดอกเบี้ยจากการลงทุนต่อ" v={fmtNum(horizon.couponsAndReinvestment, 3)} />
                <Row k={`ราคาขาย (dirty, yield ${fmtPct(horizon.exitYield, 2)})`} v={fmtNum(horizon.salePrice, 3)} />
                <Row k="ผลตอบแทนรวม" v={fmtPct(horizon.totalReturn, 2)} />
                <Row k="ผลตอบแทนต่อปี (เทียบกับ YTM)" v={fmtPct(horizon.annualizedReturn, 3)} strong />
              </div>
            )}
            {!horizonDate && <p className="text-xs text-muted">ใส่วันที่ขายเพื่อดูผลตอบแทนจริงซึ่งขึ้นกับ yield ตอนขายและอัตราที่นำคูปองไปลงทุนต่อ</p>}
          </section>
          <section className="card space-y-3">
            <h2 className="text-[15px] font-semibold">มูลค่าจาก zero curve, Z-spread และ key-rate duration</h2>
            <label className="block">
              <span className="label">Zero rate (ปี: % ต่อปี ทบต้นรายปี) บรรทัดละจุด</span>
              <textarea className="input font-mono text-xs" rows={4} value={curveText} onChange={(e) => setCurveText(e.target.value)} />
            </label>
            {curveRes && "error" in curveRes && <p className="text-sm text-neg">{curveRes.error}</p>}
            {curveRes && !("error" in curveRes) && (
              <div>
                <Row k="ราคา clean จาก curve (spread 0)" v={fmtNum(curveRes.curvePrice, 4)} />
                <Row k="Z-spread ที่ทำให้เท่าราคาตลาด" v={`${fmtNum(curveRes.z * 10000, 1)} bp`} strong />
                <div className="mt-2 flex flex-wrap gap-x-4 text-xs">
                  {curveRes.krd.map((k) => (
                    <span key={k.years}>
                      KRD {k.years}y: <b className="tabular-nums">{fmtNum(k.duration, 3)}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-muted">ตัวอย่าง curve เป็นค่าสมมติ — ใส่ zero curve จริง (เช่น ThaiBMA) ณ วันเดียวกัน · YTM ใช้ yield เดียวทุกงวด ต่างจากการคิดลดด้วย curve</p>
          </section>
        </div>
      )}

      <section className="card">
        <h2 className="mb-3 font-semibold">ตั๋วเงินคลัง / พันธบัตรระยะสั้นแบบส่วนลด</h2>
        <div className="grid items-end gap-3 sm:grid-cols-4">
          <NumField label="จำนวนวัน" value={billDays} onChange={(v) => setBillDays(Math.max(1, Math.round(v ?? 1)))} />
          <NumField label="Yield" pct value={billYield} onChange={(v) => setBillYield(v ?? 0)} />
          <div className="pb-2 text-sm">
            ราคาต่อ 100: <b className="tabular-nums">{fmtNum(discountBillPrice(100, billYield, billDays), 4)}</b>
          </div>
          <div className="pb-2 text-xs text-muted">
            Yield = (100/ราคา − 1) × 365/วัน · ตรวจย้อนกลับ {fmtPct(discountBillYield(100, discountBillPrice(100, billYield, billDays), billDays), 3)}
          </div>
        </div>
      </section>
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input type="date" className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{v}</span>
    </div>
  );
}
