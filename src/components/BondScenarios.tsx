"use client";

/** Named bond scenarios inside the bond calculator (audit B-1). Kept in page state only (not saved). */
import { useMemo, useState } from "react";
import clsx from "clsx";
import type { ValuationInput } from "@/lib/valuation-schemas";
import { bondScenarioResults, presetBondScenarios, type BondScenarioRow } from "@/lib/bond-scenarios";
import { fmtNum, fmtPct, signClass } from "@/lib/format";

const pctIn = (v: number | null) => (v == null ? "" : String(Number((v * 100).toFixed(4))));

export function BondScenarios({ base, ytm, reinvest, horizonDate }: { base: ValuationInput | null; ytm: number; reinvest: number; horizonDate: string }) {
  const [rows, setRows] = useState<BondScenarioRow[] | null>(null);
  const res = useMemo(() => (base && rows ? bondScenarioResults(base, rows, !!horizonDate) : null), [base, rows, horizonDate]);
  const set = (i: number, patch: Partial<BondScenarioRow>) => setRows((r) => r!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  if (!base) return null;
  return (
    <section className="card space-y-3 min-w-0" aria-labelledby="bond-scen-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="bond-scen-title" className="text-[15px] font-semibold">
          Scenario ของพันธบัตร
        </h2>
        <span className="text-[11px] text-muted">เก็บในหน้านี้เท่านั้น (ไม่บันทึก)</span>
      </div>
      {!rows ? (
        <div className="space-y-2 text-xs">
          <p className="text-muted">เทียบหลายสถานการณ์ของ yield: ราคาวันนี้เมื่อ yield เปลี่ยนทันที และผลตอบแทนถึงวันขายตาม yield ตอนขายและอัตราลงทุนต่อของแต่ละ scenario</p>
          <button type="button" className="btn-ghost text-xs" onClick={() => setRows(presetBondScenarios(ytm, reinvest))}>
            เพิ่ม Bear / Base / Bull (ตัวอย่าง 25 / 50 / 25)
          </button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="table min-w-[760px] text-xs">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th className="text-right">ความน่าจะเป็น %</th>
                  <th className="text-right">Yield เปลี่ยนทันที (bp)</th>
                  <th className="text-right">ราคาสะอาดวันนี้</th>
                  <th className="text-right">Yield ตอนขาย %</th>
                  <th className="text-right">ลงทุนต่อ %</th>
                  <th className="text-right">ผลตอบแทนถึงวันขาย</th>
                  <th className="text-right">ต่อปี</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const sc = res?.summary.scenarios[i];
                  const h = res?.horizons[i];
                  const num = (label: string, value: string, on: (v: number | null) => void, placeholder?: string, w = "w-20") => (
                    <input
                      aria-label={`${label} ${s.name}`}
                      className={clsx("input py-0.5 text-right", w)}
                      inputMode="decimal"
                      defaultValue={value}
                      placeholder={placeholder}
                      title={placeholder ? `ว่าง = ${placeholder}` : undefined}
                      key={`${s.id}-${label}-${value}`}
                      onBlur={(e) => {
                        const t = e.target.value.trim();
                        const v = t === "" ? null : Number(t);
                        if (v === null || Number.isFinite(v)) on(v);
                      }}
                    />
                  );
                  return (
                    <tr key={s.id}>
                      <td>
                        <input aria-label={`ชื่อ scenario ${i + 1}`} className="input w-24 py-0.5" value={s.name} onChange={(e) => set(i, { name: e.target.value })} />
                      </td>
                      <td className="text-right">{num("ความน่าจะเป็น", pctIn(s.probability), (v) => set(i, { probability: (v ?? 0) / 100 }))}</td>
                      <td className="text-right">{num("yield shift", String(s.shiftBp), (v) => set(i, { shiftBp: v ?? 0 }))}</td>
                      <td className="text-right tabular-nums">{sc?.valuePerShare != null ? fmtNum(sc.valuePerShare, 3) : <span title={sc?.naReason ?? ""}>N/A</span>}</td>
                      <td className="text-right">{num("yield ตอนขาย", pctIn(s.exitYield), (v) => set(i, { exitYield: v == null ? null : v / 100 }), pctIn(ytm))}</td>
                      <td className="text-right">{num("อัตราลงทุนต่อ", pctIn(s.reinvestRate), (v) => set(i, { reinvestRate: v == null ? null : v / 100 }), pctIn(reinvest))}</td>
                      <td className={clsx("text-right tabular-nums", h && !("error" in h) && signClass(h.totalReturn))}>{!horizonDate ? "—" : h && !("error" in h) ? fmtPct(h.totalReturn, 2) : <span title={h && "error" in h ? h.error : ""}>N/A</span>}</td>
                      <td className="text-right tabular-nums">{h && !("error" in h) ? fmtPct(h.annualizedReturn, 2) : "—"}</td>
                      <td>
                        <button type="button" aria-label={`ลบ ${s.name}`} className="text-muted hover:text-neg" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="text-muted">ถ่วงน้ำหนัก</td>
                  <td className={clsx("text-right tabular-nums", res && Math.abs(res.summary.sumProbability - 1) > 1e-8 && "text-neg")}>{fmtPct(res?.summary.sumProbability ?? 0, 2)}</td>
                  <td />
                  <td className="text-right tabular-nums font-medium">{res?.summary.probabilityWeightedValue != null ? fmtNum(res.summary.probabilityWeightedValue, 3) : "—"}</td>
                  <td />
                  <td />
                  <td className="text-right tabular-nums font-medium">{res?.weightedHorizon != null ? fmtPct(res.weightedHorizon, 2) : "—"}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
          {[...(res?.probErrors ?? []), ...(res?.summary.errors.filter((e) => !(res?.probErrors ?? []).includes(e)) ?? [])].map((e) => (
            <p key={e} className="text-xs text-neg">
              • {e}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={rows.length >= 8}
              onClick={() => {
                let n = rows.length + 1;
                while (rows.some((s) => s.id === `custom-${n}`)) n++;
                setRows([...rows, { id: `custom-${n}`, name: `Custom ${n}`, probability: 0, shiftBp: 0, exitYield: null, reinvestRate: null }]);
              }}
            >
              + scenario
            </button>
            <button type="button" className="text-[11px] text-muted underline" onClick={() => setRows(null)}>
              ล้าง scenario
            </button>
          </div>
          <ul className="space-y-0.5 text-[11px] text-muted">
            <li>• ราคาวันนี้ = ตีราคาใหม่เต็มรูปแบบที่ yield วันนี้ + shift (ไม่ใช้ค่าประมาณ duration/convexity) · ค่าถ่วงน้ำหนัก = Σ p × ราคา</li>
            <li>• ผลตอบแทนถึงวันขาย = ซื้อที่ราคาวันนี้ รับคูปองและนำไปลงทุนต่อ แล้วขายที่ yield ตอนขาย — ไม่ใช่ YTM และไม่รับประกัน{!horizonDate && " (ใส่วันที่ขายในส่วน horizon return ด้านบนเพื่อคำนวณ)"}</li>
            <li>• ความน่าจะเป็น 25/50/25 เป็นค่าตัวอย่างที่แก้ได้ ไม่ใช่การประมาณทางสถิติ · พันธบัตรที่ไถ่ถอนก่อนกำหนดได้อาจไม่เป็นเชิงเส้น</li>
          </ul>
        </>
      )}
    </section>
  );
}
