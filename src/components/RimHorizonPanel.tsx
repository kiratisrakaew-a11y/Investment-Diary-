"use client";

import { useState } from "react";
import clsx from "clsx";
import type { RimHorizonComparison } from "@/lib/finance/rim-horizon";
import { defaultRimScenarios, type RimScenario, type RimScenarioOverrides, type rimPayoutSensitivity, type rimPersistenceSensitivity, type rimScenarioAnalysis, type rimSensitivity } from "@/lib/finance/rim-horizon";
import { fmtNum, fmtPct, signClass } from "@/lib/format";
import { compact } from "@/lib/explain-data";
import { CardTitle } from "./ExplainButton";
import { Badge } from "./ui";
import { RiWaterfallChart, RoeKeChart } from "./charts";

type Persist = ReturnType<typeof rimPersistenceSensitivity>;
type Sens = ReturnType<typeof rimSensitivity>;
type PayoutSens = ReturnType<typeof rimPayoutSensitivity>;
type ScenRes = ReturnType<typeof rimScenarioAnalysis>;

/** 5Y vs 10Y residual-income comparison on one dataset, with waterfall, book roll-forward and sensitivities. */
export function RimHorizonPanel({
  details,
  bookValue,
  scenarios,
  onScenariosChange,
  terminalMethod,
  onSaveHorizon,
  saving,
  saveMsg,
}: {
  details: Record<string, unknown>;
  bookValue: number;
  scenarios?: RimScenario[];
  onScenariosChange: (s: RimScenario[] | undefined) => void;
  terminalMethod: "perpetuity" | "persistence" | "none";
  /** Save the first h years as a separate residual_income valuation (a labelled snapshot). */
  onSaveHorizon?: (h: number) => void;
  saving?: boolean;
  saveMsg?: { ok: boolean; text: string; href?: string } | null;
}) {
  const cmp = details.horizonComparison as RimHorizonComparison | null | undefined;
  const payoutSens = details.payoutSensitivity as PayoutSens | null | undefined;
  const scenRes = details.scenarios as ScenRes | null | undefined;
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
        {onSaveHorizon && valid.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {valid.map((r) => (
              <button key={r.horizon} type="button" className="btn-ghost px-2 py-1 text-xs" disabled={saving} onClick={() => onSaveHorizon(r.horizon)}>
                บันทึกผล {r.horizon} ปีเป็น valuation แยก
              </button>
            ))}
            {saveMsg && (
              <span className={clsx("text-xs", saveMsg.ok ? "text-pos" : "text-neg")}>
                {saveMsg.text}
                {saveMsg.href && (
                  <a href={saveMsg.href} className="ml-1 text-accent underline">
                    เปิด
                  </a>
                )}
              </span>
            )}
            <span className="w-full text-[11px] text-muted">
              บันทึกเป็นภาพ (snapshot) ใช้ Residual income เดิม ตัดเหลือ h ปีแรกตามที่กรอก — แสดงในประวัติพร้อมป้าย แต่ไม่ถูกนับเป็น “ล่าสุดของวิธีนี้” จึงไม่ทับ valuation หลัก
            </span>
          </div>
        )}
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

      <RimScenarioPanel scenarios={scenarios} res={scenRes ?? null} onChange={onScenariosChange} terminalMethod={terminalMethod} />

      {(persist || sens) && (
        <section className="card overflow-x-auto">
          <CardTitle title="Sensitivity: Residual income" explain={{ data: compact({ persistence: persist, sensitivity: sens, payout: payoutSens }), hint: "ω = สัดส่วนที่ RI คงอยู่ปีต่อปีหลังจบประมาณการ (0 = หายทันที, 1 = ไม่ลดลง); ตาราง Ke × ROE / Ke × g คำนวณที่ horizon เต็มของข้อมูล; payout × ω ใช้ payout เดียวกันทุกปี — payout สูงทำให้ book value โตช้า RI ปีหลังจึงน้อยลง" }} />
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
            {payoutSens && (
              <Grid
                title={`Payout × ω (persistence, ${payoutSens.horizon} ปี)`}
                rowLabel="Payout ↓ / ω →"
                rows={payoutSens.payouts}
                cols={payoutSens.omegas}
                grid={payoutSens.grid}
                base={sens?.base ?? null}
                colFmt={(x) => String(x)}
                highlight={false}
              />
            )}
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

function Grid({
  title,
  rows,
  cols,
  grid,
  base,
  colFmt,
  rowLabel = "Ke ↓",
  highlight = true,
}: {
  title: string;
  rows: number[];
  cols: number[];
  grid: (number | null)[][];
  base: number | null;
  colFmt: (x: number) => string;
  rowLabel?: string;
  highlight?: boolean;
}) {
  const mid = Math.floor(rows.length / 2);
  const midC = Math.floor(cols.length / 2);
  return (
    <div className="min-w-0 overflow-x-auto">
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <table className="data-grid text-xs">
        <thead>
          <tr>
            <th className="px-2 py-1 text-left whitespace-nowrap text-muted">{rowLabel}</th>
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
                    className={clsx("px-2 py-1 text-right tabular-nums", highlight && i === mid && j === midC && "font-semibold", v == null && "text-muted")}
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

const SCEN_FIELDS: { key: keyof RimScenarioOverrides; label: string; pct: boolean; when?: "perpetuity" | "persistence" | "not_none"; shift?: boolean }[] = [
  { key: "roeShift", label: "ROE ± (จุด)", pct: true, shift: true },
  { key: "payoutRatio", label: "Payout", pct: true },
  { key: "terminalRoe", label: "ROE ระยะยาว", pct: true, when: "not_none" },
  { key: "terminalGrowth", label: "g ระยะยาว", pct: true, when: "perpetuity" },
  { key: "persistence", label: "ω", pct: false, when: "persistence" },
];

/** Bear / Base / Bull for residual income: the same probability rules as the DCF scenarios. */
function RimScenarioPanel({
  scenarios,
  res,
  onChange,
  terminalMethod,
}: {
  scenarios?: RimScenario[];
  res: ScenRes | null;
  onChange: (s: RimScenario[] | undefined) => void;
  terminalMethod: "perpetuity" | "persistence" | "none";
}) {
  const sc = scenarios ?? [];
  const fields = SCEN_FIELDS.filter((f) => !f.when || (f.when === "not_none" ? terminalMethod !== "none" : f.when === terminalMethod));
  const update = (i: number, patch: Partial<RimScenario>) => onChange(sc.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <section className="card overflow-x-auto">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <CardTitle
          title="Scenarios (Bear / Base / Bull) — Residual income"
          explain={res ? { data: compact({ scenarios: sc, ผล: res }), hint: "มูลค่าคาดหวัง = Σ ความน่าจะเป็น × มูลค่าแต่ละกรณี; เป็นค่าเฉลี่ยถ่วงน้ำหนักของสมมติฐาน ไม่ใช่ความแน่นอน" } : null}
        />
        <div className="flex items-center gap-3">
          {sc.length > 0 && (
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => onChange(defaultRimScenarios())}>
              รีเซ็ตเป็นตัวอย่าง
            </button>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sc.length > 0} onChange={(e) => onChange(e.target.checked ? defaultRimScenarios() : undefined)} />
            ใช้ scenarios
          </label>
        </div>
      </div>
      {!sc.length ? (
        <p className="text-xs text-muted">เปิดเพื่อกำหนด Bear/Base/Bull พร้อมความน่าจะเป็น — ค่าเริ่มต้นเป็นตัวอย่าง (ROE ±2 จุดจากเส้นทางที่กรอก) ไม่ใช่การพยากรณ์</p>
      ) : (
        <>
          <table className="data-grid table text-xs">
            <thead>
              <tr>
                <th>กรณี</th>
                <th className="num">โอกาส (%)</th>
                {fields.map((f) => (
                  <th key={f.key} className="num">
                    {f.label}
                    {f.pct && !f.shift ? " (%)" : ""}
                  </th>
                ))}
                <th className="num">มูลค่า/หุ้น</th>
                <th className="num">Upside</th>
              </tr>
            </thead>
            <tbody>
              {sc.map((x, i) => {
                const row = res?.rows[i];
                return (
                  <tr key={i}>
                    <td>
                      <input aria-label={`ชื่อกรณีที่ ${i + 1}`} className="input w-20 py-1 text-xs" value={x.name} onChange={(e) => update(i, { name: e.target.value })} />
                    </td>
                    <td className="num">
                      <Num label={`ความน่าจะเป็น ${x.name}`} value={x.probability} scale={100} onChange={(v) => update(i, { probability: v ?? 0 })} />
                    </td>
                    {fields.map((f) => (
                      <td key={f.key} className="num">
                        <Num
                          label={`${f.label} ${x.name}`}
                          value={x.overrides[f.key]}
                          scale={f.pct ? 100 : 1}
                          placeholder={f.shift ? "0" : "base"}
                          onChange={(v) => {
                            const o = { ...x.overrides };
                            if (v == null) delete o[f.key];
                            else o[f.key] = v;
                            update(i, { overrides: o });
                          }}
                        />
                      </td>
                    ))}
                    <td className="num font-medium" title={[...(row?.errors ?? []), ...(row && "notes" in row ? (row.notes as string[]) : [])].join(" · ") || undefined}>
                      {row?.value == null && row?.errors.length ? <span className="text-neg">⚠️</span> : fmtNum(row?.value)}
                    </td>
                    <td className={clsx("num", signClass(row?.upside))}>{fmtPct(row?.upside, 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {res && (
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                มูลค่าคาดหวัง <b className="tabular-nums">{fmtNum(res.expectedValue)}</b> <span className={signClass(res.expectedUpside)}>({fmtPct(res.expectedUpside, 1)})</span>
              </span>
              <span className="text-muted">
                ช่วง {fmtNum(res.low)} – {fmtNum(res.high)} · σ {fmtNum(res.stdev)} · ที่ {res.horizon} ปี
              </span>
              {res.errors.map((e) => (
                <span key={e} className="text-xs text-neg">
                  ⚠️ {e}
                </span>
              ))}
            </div>
          )}
          <ScenarioDisclaimer />
        </>
      )}
    </section>
  );
}

/** Keeps three different ideas apart: model sensitivity, scenario probability and conviction. */
export function ScenarioDisclaimer() {
  return (
    <p className="mt-2 text-xs text-muted">
      ช่องว่าง = ใช้ค่าเดียวกับ base · <b>Sensitivity</b> = ตัวเลขเปลี่ยนเท่าไรเมื่อสมมติฐานขยับ · <b>ความน่าจะเป็นของ scenario</b> = น้ำหนักที่คุณให้แต่ละกรณี (ตั้งเอง ไม่ใช่สถิติตลาด) ·
      มูลค่าคาดหวังเป็นค่าเฉลี่ยถ่วงน้ำหนัก ไม่ใช่ความแน่นอน และไม่ได้บอก<b>ความมั่นใจในการลงทุน</b> — บันทึก valuation เพื่อเก็บ scenarios ไว้กับสมมติฐาน
    </p>
  );
}

function Num({ value, onChange, scale, placeholder, label }: { value: number | undefined; onChange: (v: number | null) => void; scale: number; placeholder?: string; label: string }) {
  const shown = value == null ? "" : String(Number((value * scale).toFixed(4)));
  return (
    <input
      key={shown}
      aria-label={label}
      className="input w-16 py-1 text-right text-xs tabular-nums"
      inputMode="decimal"
      defaultValue={shown}
      placeholder={placeholder}
      onBlur={(e) => {
        const t = e.target.value.trim();
        if (t === shown) return;
        if (t === "") return onChange(null);
        const n = Number(t);
        if (Number.isFinite(n)) onChange(n / scale);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
