"use client";

import { useState } from "react";
import clsx from "clsx";
import type { RimHorizonComparison } from "@/lib/finance/rim-horizon";
import type { rimPersistenceSensitivity, rimSensitivity } from "@/lib/finance/rim-horizon";
import { fmtNum, fmtPct, signClass } from "@/lib/format";
import { compact } from "@/lib/explain-data";
import { CardTitle } from "./ExplainButton";
import { Badge } from "./ui";
import { RiWaterfallChart, RoeKeChart } from "./charts";

type Persist = ReturnType<typeof rimPersistenceSensitivity>;
type Sens = ReturnType<typeof rimSensitivity>;

/** 5Y vs 10Y residual-income comparison on one dataset, with waterfall, book roll-forward and sensitivities. */
export function RimHorizonPanel({ details, bookValue }: { details: Record<string, unknown>; bookValue: number }) {
  const cmp = details.horizonComparison as RimHorizonComparison | null | undefined;
  const persist = details.persistenceSensitivity as Persist | null | undefined;
  const sens = details.sensitivity as Sens | null | undefined;
  const valid = cmp?.rows.filter((r) => r.status === "ok") ?? [];
  const [sel, setSel] = useState<number | null>(null);
  if (!cmp) return null;
  const active = valid.find((r) => r.horizon === sel) ?? valid[valid.length - 1];

  return (
    <div id="val-rim" className="scroll-mt-16 space-y-6">
      <section className="card">
        <CardTitle
          title="Residual income: เทียบ horizon บนข้อมูลชุดเดียวกัน"
          explain={{
            data: compact({ เทียบ: cmp.rows.map((r) => ({ ปี: r.horizon, สถานะ: r.status, มูลค่า: r.value, upside: r.upside, pvRI: r.pvResidualIncome, pvCV: r.pvContinuingValue, terminalShare: r.terminalShareOfValue, PBV: r.impliedPBV })), ส่วนต่าง: cmp.difference, หมายเหตุ: cmp.notes }),
            hint: "แต่ละ horizon ใช้ประมาณการ h ปีแรกตามที่กรอก แล้วคำนวณ continuing value ใหม่ที่ปี h; ปีที่ไม่ได้กรอกจะไม่ถูกเติม",
          }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {cmp.rows.map((r) => (
            <button
              key={r.horizon}
              type="button"
              disabled={r.status !== "ok"}
              aria-pressed={active?.horizon === r.horizon}
              onClick={() => setSel(r.horizon)}
              className={clsx("glass-inset rounded-xl p-3 text-left transition-colors disabled:cursor-not-allowed", active?.horizon === r.horizon && r.status === "ok" ? "ring-2 ring-accent/60" : "hover:border-border-strong")}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">{r.horizon} ปี</span>
                {r.status === "ok" ? <span className={clsx("text-xs", signClass(r.upside))}>{fmtPct(r.upside, 1)}</span> : <Badge>ข้อมูลไม่พอ</Badge>}
              </div>
              {r.status === "ok" ? (
                <>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtNum(r.value)}</div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                    <Row k="Book value B₀" v={fmtNum(bookValue)} />
                    <Row k="PV ของ RI" v={fmtNum(r.pvResidualIncome)} />
                    <Row k="PV continuing value" v={fmtNum(r.pvContinuingValue)} />
                    <Row k="CV / มูลค่า" v={fmtPct(r.terminalShareOfValue, 1)} />
                    <Row k="Implied P/BV" v={`${fmtNum(r.impliedPBV, 2)}x`} />
                    <Row k="Ke" v={fmtPct(r.ke, 2)} />
                    <Row k="ROE หลังปี h" v={r.terminalRoe != null ? fmtPct(r.terminalRoe, 1) : "–"} />
                  </dl>
                  {r.warnings.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-[11px] text-warn">
                      {r.warnings.map((w) => (
                        <li key={w}>⚠️ {w}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="mt-2 text-xs text-muted">{r.errors.join(" · ")}</p>
              )}
            </button>
          ))}
        </div>
        {cmp.notes.length > 0 && (
          <ul className="mt-3 space-y-0.5 text-xs text-muted">
            {cmp.notes.map((n) => (
              <li key={n}>• {n}</li>
            ))}
          </ul>
        )}
      </section>

      {active && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card min-w-0">
            <CardTitle title={`ที่มาของมูลค่า (${active.horizon} ปี)`} />
            <RiWaterfallChart
              steps={[
                { label: "B₀", delta: bookValue, kind: "book" },
                ...active.years.map((y) => ({ label: `RI${y.year}`, delta: y.pv, kind: "ri" as const })),
                { label: "CV", delta: active.pvContinuingValue ?? 0, kind: "cv" },
                { label: "มูลค่า", delta: active.value ?? 0, kind: "total" },
              ]}
            />
            <p className="mt-1 text-xs text-muted">แท่งเขียว/แดง = PV ของกำไรส่วนเกินแต่ละปี (บวก/ลบ) · ม่วง = continuing value หลังปี {active.horizon}</p>
          </section>
          <section className="card min-w-0">
            <CardTitle title="ROE เทียบ Ke" />
            <RoeKeChart data={active.years.map((y) => ({ year: `ปี ${y.year}`, roe: y.roe }))} ke={active.ke} />
            <p className="mt-1 text-xs text-muted">RI เกิดเมื่อ ROE &gt; Ke เท่านั้น — ช่วงที่ ROE ต่ำกว่า Ke ทำให้มูลค่าต่ำกว่า book value</p>
          </section>
        </div>
      )}

      {active && (
        <section className="card overflow-x-auto">
          <CardTitle title={`Book value roll-forward (${active.horizon} ปี)`} />
          <table className="data-grid table text-xs">
            <thead>
              <tr>
                <th>ปี</th>
                <th className="num">B ต้นปี</th>
                <th className="num">+ กำไร</th>
                <th className="num">− ปันผล</th>
                <th className="num">ปรับ (stated − clean)</th>
                <th className="num">B ปลายปี</th>
                <th className="num">ROE</th>
                <th className="num">RI</th>
                <th>ที่มา</th>
              </tr>
            </thead>
            <tbody>
              {active.years.map((y) => (
                <tr key={y.year}>
                  <td>{y.year}</td>
                  <td className="num">{fmtNum(y.bookValueStart)}</td>
                  <td className="num">{fmtNum(y.earnings)}</td>
                  <td className="num">{fmtNum(y.dividends)}</td>
                  <td className={clsx("num", Math.abs(y.cleanSurplusGap ?? 0) > 1e-9 && "text-warn")}>{fmtNum(y.cleanSurplusGap ?? 0)}</td>
                  <td className="num">{fmtNum(y.bookValueEnd)}</td>
                  <td className="num">{fmtPct(y.roe, 1)}</td>
                  <td className={clsx("num", signClass(y.residualIncome))}>{fmtNum(y.residualIncome)}</td>
                  <td className="space-x-1">
                    <Badge>{y.earningsSource === "eps" ? "EPS ที่ระบุ" : "ROE × B ต้นปี"}</Badge>
                    {y.bookValueSource === "stated" && <Badge>B ที่ระบุ</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            EPS ที่ระบุจะใช้แทน ROE × B ต้นปี (ROE ในตารางคำนวณกลับจาก EPS) · B ปลายปีใช้ clean surplus B + E − D เว้นแต่ระบุไว้ — ช่อง “ปรับ” ≠ 0 คือรายการที่ไม่ผ่านกำไร (OCI, เพิ่มทุน, ซื้อหุ้นคืน) ซึ่งทำให้ RI ไม่ครบหรือซ้ำ ควรตรวจกับงบจริง
          </p>
        </section>
      )}

      {(persist || sens) && (
        <section className="card overflow-x-auto">
          <CardTitle title="Sensitivity: Residual income" explain={{ data: compact({ persistence: persist, sensitivity: sens }), hint: "ω = สัดส่วนที่ RI คงอยู่ปีต่อปีหลังจบประมาณการ (0 = หายทันที, 1 = ไม่ลดลง); ตาราง Ke × ROE / Ke × g คำนวณที่ horizon เต็มของข้อมูล" }} />
          <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
            {persist && (
              <div className="min-w-0 overflow-x-auto">
                <h3 className="mb-1 text-sm font-medium">มูลค่าตาม persistence ω</h3>
                <table className="data-grid text-xs">
                  <thead>
                    <tr>
                      <th className="px-2 py-1 text-left whitespace-nowrap text-muted">horizon ↓ / ω →</th>
                      {persist.omegas.map((w) => (
                        <th key={w} className="px-2 py-1 text-right text-muted">{w}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {persist.rows.map((r) => (
                      <tr key={r.horizon}>
                        <th className="px-2 py-1 text-left font-medium text-muted">{r.horizon} ปี</th>
                        {r.values.map((v, i) => (
                          <td key={i} className="px-2 py-1 text-right tabular-nums">{v != null ? fmtNum(v) : "N/A"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {sens?.keRoe && <Grid title={`Ke × ROE หลังปี ${sens.horizon}`} rows={sens.keRoe.ke} cols={sens.keRoe.roe} grid={sens.keRoe.grid} base={sens.base} colFmt={(x) => fmtPct(x, 1)} />}
            {sens?.keGrowth && <Grid title={`Ke × g ระยะยาว (${sens.horizon} ปี)`} rows={sens.keGrowth.ke} cols={sens.keGrowth.g} grid={sens.keGrowth.grid} base={sens.base} colFmt={(x) => fmtPct(x, 1)} />}
          </div>
          <p className="mt-2 text-xs text-muted">N/A = สมมติฐานใช้ไม่ได้ (เช่น Ke ≤ g) — ไม่ได้ปรับค่าให้อัตโนมัติ{!sens?.keGrowth ? " · ตาราง Ke × g แสดงเมื่อใช้ continuing value แบบโตต่อเนื่อง (perpetuity)" : ""}</p>
        </section>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="text-right tabular-nums">{v}</dd>
    </>
  );
}

function Grid({ title, rows, cols, grid, base, colFmt }: { title: string; rows: number[]; cols: number[]; grid: (number | null)[][]; base: number | null; colFmt: (x: number) => string }) {
  const mid = Math.floor(rows.length / 2);
  const midC = Math.floor(cols.length / 2);
  return (
    <div className="min-w-0 overflow-x-auto">
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <table className="data-grid text-xs">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left text-muted">Ke ↓</th>
            {cols.map((c, j) => (
              <th key={j} className="px-2 py-1 text-right text-muted">{colFmt(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, i) => (
            <tr key={i}>
              <th className="px-2 py-1 text-left font-medium text-muted">{fmtPct(rows[i], 1)}</th>
              {row.map((v, j) => {
                const rel = v != null && base ? v / base - 1 : 0;
                const c = Math.min(1, Math.abs(rel) * 2);
                return (
                  <td
                    key={j}
                    className={clsx("px-2 py-1 text-right tabular-nums", i === mid && j === midC && "font-semibold", v == null && "text-muted")}
                    style={v != null ? { background: `color-mix(in oklab, ${rel >= 0 ? "var(--series-3)" : "var(--series-2)"} ${c * 40}%, transparent)` } : undefined}
                  >
                    {v != null ? fmtNum(v) : "N/A"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
