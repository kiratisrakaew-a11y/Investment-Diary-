"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { analyticsFromPrice, analyticsFromYield, discountBillPrice, discountBillYield, priceChangeApprox, priceYieldCurve, yieldToCall, type BondSpec } from "@/lib/finance/bonds";
import { NumField, SelectField } from "./fields";
import { fmtNum, fmtPct } from "@/lib/format";

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
  const [callDate, setCallDate] = useState("");
  const [callPrice, setCallPrice] = useState(100);
  const [shock, setShock] = useState(0.01);

  const spec: BondSpec = { settlement, maturity, couponRate: coupon, frequency: Number(freq) as 1 | 2 | 4 | 12 };
  const r = useMemo(() => {
    try {
      return { ok: true as const, a: mode === "price" ? analyticsFromPrice(spec, price) : analyticsFromYield(spec, ytm) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settlement, maturity, coupon, freq, mode, price, ytm]);
  const curve = useMemo(() => (r.ok ? priceYieldCurve(spec, r.a.ytm) : []), [r]); // eslint-disable-line react-hooks/exhaustive-deps
  const ytc = useMemo(() => {
    if (!r.ok || !callDate || callDate >= maturity || callDate <= settlement) return null;
    try {
      return yieldToCall(spec, r.a.cleanPrice, callDate, callPrice);
    } catch {
      return null;
    }
  }, [r, callDate, callPrice]); // eslint-disable-line react-hooks/exhaustive-deps

  const [billDays, setBillDays] = useState(91);
  const [billYield, setBillYield] = useState(0.019);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-5">
        <section className="card space-y-3 lg:col-span-2">
          <h2 className="font-semibold">ข้อมูลพันธบัตร / หุ้นกู้</h2>
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
            <label className="block">
              <span className="label">วันที่ไถ่ถอนก่อนกำหนด (ถ้ามี)</span>
              <input type="date" className="input" value={callDate} onChange={(e) => setCallDate(e.target.value)} />
            </label>
            <NumField label="ราคาไถ่ถอน (call price)" value={callPrice} onChange={(v) => setCallPrice(v ?? 100)} />
          </div>
        </section>

        <section className="card lg:col-span-3">
          <h2 className="mb-3 font-semibold">ผลลัพธ์</h2>
          {!r.ok ? (
            <p className="text-sm text-neg">{r.error}</p>
          ) : (
            <div className="grid gap-x-8 sm:grid-cols-2">
              <div>
                <Row k="Yield to maturity" v={fmtPct(r.a.ytm, 3)} strong />
                <Row k="ราคา clean" v={fmtNum(r.a.cleanPrice, 4)} strong />
                <Row k="ดอกเบี้ยค้างรับ (accrued)" v={fmtNum(r.a.accruedInterest, 4)} />
                <Row k="ราคา dirty (ที่จ่ายจริง)" v={fmtNum(r.a.dirtyPrice, 4)} />
                <Row k="Current yield" v={fmtPct(r.a.currentYield, 3)} />
                {ytc != null && <Row k="Yield to call" v={fmtPct(ytc, 3)} />}
              </div>
              <div>
                <Row k="อายุคงเหลือ" v={`${fmtNum(r.a.yearsToMaturity, 2)} ปี`} />
                <Row k="Macaulay duration" v={`${fmtNum(r.a.macaulayDuration, 3)} ปี`} />
                <Row k="Modified duration" v={fmtNum(r.a.modifiedDuration, 3)} />
                <Row k="Convexity" v={fmtNum(r.a.convexity, 2)} />
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
                    <b>{fmtPct(analyticsFromYield(spec, r.a.ytm + shock).cleanPrice / r.a.cleanPrice - 1, 2)}</b>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {r.ok && (
        <div className="grid gap-6 lg:grid-cols-5">
          <section className="card lg:col-span-3">
            <h2 className="mb-3 font-semibold">Price–Yield curve (ความโค้ง = convexity)</h2>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={curve} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="ytm" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v) => `${(v * 100).toFixed(1)}%`} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis domain={["auto", "auto"]} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(v) => [fmtNum(Number(v), 3), "ราคา clean"]}
                  labelFormatter={(v) => `YTM ${(Number(v) * 100).toFixed(2)}%`}
                />
                <Line type="monotone" dataKey="price" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <ReferenceDot x={r.a.ytm} y={r.a.cleanPrice} r={6} fill="var(--series-2)" stroke="var(--panel)" strokeWidth={2} />
              </LineChart>
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
                      <td>{f.date}</td>
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

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className={strong ? "font-semibold tabular-nums" : "tabular-nums"}>{v}</span>
    </div>
  );
}
