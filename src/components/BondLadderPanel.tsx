"use client";

import { useState } from "react";
import type { planBondLadder } from "@/server/services/bonds";
import { fmtNum, fmtPct, fmtThb } from "@/lib/format";
import { compact } from "@/lib/explain-data";
import { LadderCashflowChart } from "./charts";
import { NumField, Toggle } from "./fields";
import { CardTitle } from "./ExplainButton";
import { Badge } from "./ui";

type Plan = Awaited<ReturnType<typeof planBondLadder>>;

/** Bond ladder planner (forward scenario; proposal only). */
export function BondLadderPanel() {
  const [budget, setBudget] = useState<number | null>(1_000_000);
  const [rungs, setRungs] = useState<number | null>(5);
  const [maxIssuer, setMaxIssuer] = useState<number | null>(null);
  const [minRating, setMinRating] = useState("");
  const [maxPd, setMaxPd] = useState<number | null>(null);
  const [allowUnrated, setAllowUnrated] = useState(true);
  const [reinvest, setReinvest] = useState<number | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/bonds/ladder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ budget, rungs, maxPerIssuer: maxIssuer, minRating: minRating || null, maxOneYearPd: maxPd, allowUnrated, reinvestRate: reinvest }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? data.issues?.map((i: { message: string }) => i.message).join(", ") ?? `HTTP ${r.status}`);
      setPlan(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <NumField label="งบประมาณ (บาท)" value={budget} onChange={setBudget} />
        <NumField label="จำนวนขั้น (ปี)" value={rungs} onChange={(v) => setRungs(v == null ? null : Math.max(1, Math.min(15, Math.round(v))))} />
        <NumField label="สูงสุด/ผู้ออก" pct nullable value={maxIssuer} onChange={setMaxIssuer} />
        <label className="block">
          <span className="label">อันดับขั้นต่ำ</span>
          <input className="input" placeholder="เช่น BBB-" value={minRating} onChange={(e) => setMinRating(e.target.value.toUpperCase())} />
        </label>
        <NumField label="PD 1 ปี สูงสุด" pct nullable value={maxPd} onChange={setMaxPd} />
        <NumField label="สมมติลงทุนต่อที่" pct nullable value={reinvest} onChange={setReinvest} hint="ใช้คำนวณสถานการณ์รายได้จากเงินที่ครบกำหนด" />
        <div className="flex items-end pb-2">
          <Toggle label="รวมที่ไม่มีอันดับ" checked={allowUnrated} onChange={setAllowUnrated} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" onClick={run} disabled={pending || !budget || !rungs}>
          {pending ? "กำลังจัด…" : "จัดขั้นบันไดพันธบัตร"}
        </button>
        <span className="text-xs text-muted">ใช้พันธบัตรในแอปที่มีอัตราคูปอง วันครบกำหนด มูลค่าที่ตราไว้ และราคาล่าสุด · เป็นข้อเสนอเท่านั้น</span>
      </div>
      {error && <p className="text-sm text-neg">{error}</p>}

      {plan && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ["ลงทุน", fmtThb(plan.totals.invested)],
              ["เงินสดคงเหลือ", fmtThb(plan.totals.cash)],
              ["Yield พอร์ต (XIRR)", plan.portfolioYield?.rate != null ? fmtPct(plan.portfolioYield.rate, 2) : "–"],
              ["Modified duration", plan.weightedModifiedDuration != null ? fmtNum(plan.weightedModifiedDuration, 2) : "–"],
              ["DV01 (บาท/1bp)", fmtNum(plan.totals.dv01, 0)],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border bg-panel-2/60 p-3">
                <div className="text-[11px] text-muted uppercase">{k}</div>
                <div className="text-lg font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
          <div>
            <CardTitle
              title="กระแสเงินสดรายปี (ดอกเบี้ย vs เงินต้น)"
              explain={{ data: compact({ ปี: plan.cashflowsByYear, yield: plan.portfolioYield, duration: plan.weightedModifiedDuration, ลงทุนต่อ: plan.reinvestment, ขั้นว่าง: plan.gaps }), hint: "บันไดพันธบัตร = แบ่งเงินลงทุนให้ครบกำหนดทยอยทุกปี; เงินต้นที่คืนแต่ละปีต้องลงทุนต่อ (ความเสี่ยงดอกเบี้ยตอนลงทุนต่อ)" }}
            />
            {plan.cashflowsByYear.length ? <LadderCashflowChart data={plan.cashflowsByYear} /> : <p className="text-sm text-muted">ไม่มีพันธบัตรที่ใช้ได้</p>}
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>ขั้น</th>
                  <th>พันธบัตร</th>
                  <th>ครบกำหนด</th>
                  <th className="num">หน่วย</th>
                  <th className="num">ราคา clean / dirty</th>
                  <th className="num">ต้นทุน</th>
                  <th className="num">YTM</th>
                  <th className="num">Mod. dur.</th>
                  <th>เครดิต</th>
                </tr>
              </thead>
              <tbody>
                {plan.rungs.map((r) =>
                  r.holdings.length ? (
                    plan.holdings
                      .filter((h) => h.rung === r.rung)
                      .map((h) => (
                        <tr key={h.symbol}>
                          <td>ปีที่ {r.rung}</td>
                          <td className="font-medium">{h.symbol}</td>
                          <td>{h.maturity}</td>
                          <td className="num">{fmtNum(h.units, 0)}</td>
                          <td className="num">
                            {fmtNum(h.cleanPer100, 3)} / {fmtNum(h.dirtyPer100, 3)}
                          </td>
                          <td className="num">{fmtThb(h.cost)}</td>
                          <td className="num">{fmtPct(h.ytm, 2)}</td>
                          <td className="num">{fmtNum(h.modifiedDuration, 2)}</td>
                          <td>
                            <Badge>{h.rating ?? "ไม่มีอันดับ"}</Badge>
                            {h.oneYearPd != null && <span className="ml-1 text-xs text-muted">PD {fmtPct(h.oneYearPd, 2)}</span>}
                          </td>
                        </tr>
                      ))
                  ) : (
                    <tr key={`gap${r.rung}`}>
                      <td>ปีที่ {r.rung}</td>
                      <td colSpan={8} className="text-xs text-warn">
                        ไม่มีพันธบัตรที่ครบกำหนดในขั้นนี้ — เงินส่วนนี้คงเป็นเงินสด
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {plan.reinvestment && (
            <p className="text-xs text-muted">
              สถานการณ์ลงทุนต่อ (สมมติฐาน): {plan.reinvestment.map((r) => `${r.year}: ได้คืน ${fmtThb(r.toReinvest)} → รายได้ปีถัดไป ~${fmtThb(r.incomeNextYear)}`).join(" · ")}
            </p>
          )}
          {(plan.excluded.length > 0 || plan.missingTerms.length > 0) && (
            <ul className="space-y-0.5 text-xs text-muted">
              {plan.excluded.map((e) => (
                <li key={e.symbol}>
                  ✕ {e.symbol}: {e.detail}
                </li>
              ))}
              {plan.missingTerms.map((e) => (
                <li key={e.symbol}>
                  ✕ {e.symbol}: {e.reason}
                </li>
              ))}
            </ul>
          )}
          <ul className="space-y-0.5 text-xs text-muted">
            {[...plan.warnings, ...plan.methodology, plan.note].map((m) => (
              <li key={m}>• {m}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
