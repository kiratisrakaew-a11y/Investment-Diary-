"use client";

/**
 * PR15 — scenarios, probability-weighted value, sensitivity, reverse DCF, Monte Carlo and Thai notes
 * for any valuation method. Deterministic parts run in the browser with the same engine as the server;
 * Monte Carlo runs on the server. Saving always recomputes on the server.
 */
import { useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import type { ValuationInput } from "@/lib/valuation-schemas";
import { presetScenarios, proposeNormalised, runScenarios, SCENARIO_PATHS, segmentKey, VIRTUAL_DRIVERS, type ScenarioSummary } from "@/lib/valuation-scenarios";
import { defaultReverse, defaultSensitivity, reverseSolve, sensitivityGrid, type ReverseResult, type SensitivityResult } from "@/lib/valuation-analytics";
import { appendCorrelationIndex, checkCorrelation, defaultMonteCarloVariable, identityCorrelation, removeCorrelationIndex, setCorrelationPair, type MonteCarloResult } from "@/lib/valuation-montecarlo";
import type { DistributionSpec, MonteCarloConfig, ReverseConfig, ScenarioSet, SensitivityConfig, ValuationScenario } from "@/lib/valuation-scenario-schema";
import { generateScenarioNoteTh, inputHash, lineDiff } from "@/lib/valuation-notes-th";
import { hasScenarios } from "@/lib/valuation-analyze";
import { analyzeValuationAction } from "@/app/(app)/valuation/actions";
import { fmtNum, fmtPct, signClass } from "@/lib/format";

type Tab = "scenarios" | "sensitivity" | "reverse" | "montecarlo" | "notes";
const TABS: { id: Tab; label: string }[] = [
  { id: "scenarios", label: "Scenario" },
  { id: "sensitivity", label: "Sensitivity" },
  { id: "reverse", label: "Reverse DCF" },
  { id: "montecarlo", label: "Monte Carlo" },
  { id: "notes", label: "คำอธิบาย" },
];

const QUALITY: Record<ScenarioSummary["qualityStatus"], { label: string; cls: string }> = {
  verified_inputs: { label: "ผ่านเกณฑ์ตรวจอัตโนมัติ", cls: "border-pos/40 text-pos" },
  preliminary: { label: "Preliminary — เบื้องต้น", cls: "border-warn/50 text-warn" },
  insufficient_data: { label: "ข้อมูลไม่พอ", cls: "border-neg/50 text-neg" },
};

/** Concrete path suggestions for the method (SOTP placeholders expanded with real segment ids). */
function pathOptions(input: ValuationInput): string[] {
  const base = SCENARIO_PATHS[input.method].filter((p) => !p.includes("<"));
  if (input.method === "sotp") {
    const a = input.assumptions;
    const segs = a.segments.flatMap((s) => {
      const k = segmentKey(s);
      const src = s.source;
      const fields = src.type === "market" ? ["source.price"] : src.type === "multiple" ? ["source.metric", "source.multiple"] : src.type === "manual" ? ["source.value"] : [];
      const model =
        src.type === "model"
          ? SCENARIO_PATHS[src.valuation.method].filter((p) => !p.includes("<") && p !== "discountRate").map((p) => `model.${p}`)
          : [];
      return ["ownership", "fx", "netDebt", ...fields, ...model].map((f) => `segments[${k}].${f}`);
    });
    const lines = (["nonOperatingAssets", "otherClaims", "eliminations"] as const).flatMap((l) => a[l].map((x) => `${l}[${x.name}].value`));
    return [...base, ...segs, ...lines];
  }
  if ((input.method === "dcf_fcff" || input.method === "dcf_fcfe") && input.assumptions.forecastMode === "staged")
    return [...base, ...(input.assumptions.stages ?? []).flatMap((st, i) => ["revenueGrowthStart", "revenueGrowthEnd", "ebitMarginStart", "ebitMarginEnd", "capexPct"].map((f) => `stages[${st.id ?? i + 1}].${f}`))];
  return base;
}

const parseVal = (path: string, text: string): number | string | null => {
  if (/(^|\.)scenario$/.test(path)) return text.trim() || null;
  const n = Number(text.replace(/,/g, ""));
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
};
const parseList = (t: string) => t.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);

export function ScenarioWorkbench({
  input,
  onChange,
  saved,
}: {
  input: ValuationInput;
  onChange: (set: ScenarioSet | undefined) => void;
  saved?: { inputHash?: string; savedAt?: string } | null;
}) {
  const set = (input.assumptions as { scenarioSet?: ScenarioSet }).scenarioSet;
  const [tab, setTab] = useState<Tab>("scenarios");
  const summary = useMemo(() => {
    try {
      return hasScenarios(input) ? runScenarios(input) : null;
    } catch {
      return null;
    }
  }, [input]);
  const hash = useMemo(() => inputHash(input.assumptions), [input]);
  const stale = saved?.inputHash != null && saved.inputHash !== hash;
  const update = (patch: Partial<ScenarioSet>) => onChange({ version: 1, mode: "custom", scenarios: [], ...(set ?? {}), ...patch });
  const isDcfLike = input.method === "dcf_fcff" || input.method === "dcf_fcfe" || input.method === "sotp";

  return (
    <section className="card glass min-w-0" aria-labelledby="scen-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="scen-title" className="text-[15px] font-semibold">
          Scenario · ความน่าจะเป็น · การวิเคราะห์ความไว
        </h2>
        {summary && <span className={clsx("rounded-full border px-2 py-0.5 text-[11px]", QUALITY[summary.qualityStatus].cls)}>{QUALITY[summary.qualityStatus].label}</span>}
      </div>
      {stale && (
        <p className="mt-2 rounded-lg border border-warn/40 px-3 py-2 text-xs text-warn" role="status">
          ผล scenario ที่บันทึกไว้ ({saved?.savedAt?.slice(0, 10)}) ไม่ตรงกับสมมติฐานปัจจุบัน — บันทึกอีกครั้งเพื่อให้ระบบคำนวณใหม่
        </p>
      )}
      <Kpis input={input} summary={summary} />
      <div role="tablist" aria-label="การวิเคราะห์" className="mt-3 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={clsx("-mb-px rounded-t-lg border-b-2 px-3 py-1.5 text-xs", tab === t.id ? "border-accent font-medium text-text" : "border-transparent text-muted hover:text-text")}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-3 min-w-0">
        {tab === "scenarios" && <ScenarioTab input={input} set={set} summary={summary} update={update} clear={() => onChange(set?.monteCarlo ? { ...set, scenarios: [], mode: "custom" } : undefined)} />}
        {tab === "sensitivity" && <SensitivityTab input={input} />}
        {tab === "reverse" && (isDcfLike ? <ReverseTab input={input} /> : <p className="text-xs text-muted">Reverse DCF ใช้ได้กับ FCFF / FCFE / SOTP ที่มีส่วนงาน DCF — วิธีนี้ดูตัวคูณโดยนัย (implied P/E, P/BV) ในผลหลักแทน</p>)}
        {tab === "montecarlo" && <MonteCarloTab input={input} set={set} update={update} />}
        {tab === "notes" && <NotesTab input={input} set={set} summary={summary} update={update} />}
      </div>
    </section>
  );
}

function Kpis({ input, summary }: { input: ValuationInput; summary: ScenarioSummary | null }) {
  const unit = input.method === "bond" ? " (ราคาต่อ 100)" : "";
  const k = (label: string, value: string, sub?: string, tone?: string) => (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx("text-[22px] font-semibold tabular-nums leading-tight", tone)}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {k("ราคาตลาด", fmtNum(summary?.price ?? (input.assumptions as { currentPrice?: number }).currentPrice ?? null))}
      {k(`มูลค่ากรณีฐาน (Base)${unit}`, fmtNum(summary?.baseCaseValue ?? null), "จากสมมติฐานที่กรอก")}
      {k(
        `มูลค่าถ่วงน้ำหนักความน่าจะเป็น${unit}`,
        summary?.probabilityWeightedValue != null ? fmtNum(summary.probabilityWeightedValue) : "—",
        summary?.probabilityWeightedValue != null ? (summary.qualityStatus === "preliminary" ? "เบื้องต้น — ยังไม่ยืนยัน" : "ค่าคาดหวังจากแบบจำลอง") : summary ? "ยังคำนวณไม่ได้ (ดูข้อผิดพลาด)" : "ยังไม่มี scenario",
        summary?.qualityStatus === "preliminary" ? "text-warn" : undefined,
      )}
      {k("Scenario", summary ? String(summary.scenarios.length) : "0", summary ? `ณ ${summary.asOf} · ${summary.modelVersion}` : undefined)}
    </div>
  );
}

function ScenarioTab({ input, set, summary, update, clear }: { input: ValuationInput; set?: ScenarioSet; summary: ScenarioSummary | null; update: (p: Partial<ScenarioSet>) => void; clear: () => void }) {
  const derived = set?.mode === "from_segments";
  const scen = set?.scenarios ?? [];
  const [proposal, setProposal] = useState<ReturnType<typeof proposeNormalised>>(null);
  const opts = useMemo(() => pathOptions(input), [input]);
  const setScen = (i: number, patch: Partial<ValuationScenario>) => update({ scenarios: scen.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  if (!summary)
    return (
      <div className="space-y-2 text-xs">
        <p className="text-muted">ยังไม่มี scenario — มูลค่าที่บันทึกยังเป็นกรณีฐานเดิม ไม่มีค่าถ่วงน้ำหนัก</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => update({ mode: "custom", scenarios: presetScenarios(input) })}>
            เพิ่ม Bear / Base / Bull (ตัวอย่าง 25 / 50 / 25)
          </button>
          {input.method === "sotp" && (
            <button type="button" className="btn-ghost text-xs" onClick={() => update({ mode: "from_segments", scenarios: [] })}>
              ใช้ scenario ของโมเดลส่วนงาน (คำนวณ SOTP ใหม่ทุก scenario)
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted">ความน่าจะเป็น 25/50/25 เป็นค่าตัวอย่างที่แก้ได้ ไม่ใช่การประมาณทางสถิติ</p>
      </div>
    );

  const values = summary.scenarios.map((s) => s.valuePerShare).filter((v): v is number => v != null);
  return (
    <div className="space-y-3">
      {derived && <p className="text-[11px] text-muted">สร้างจาก scenario ของโมเดลส่วนงาน — แก้ความน่าจะเป็นที่โมเดลส่วนงาน · ส่วนงานที่ไม่มี scenario ใช้มูลค่าฐาน</p>}
      <div className="overflow-x-auto">
        <table className="table min-w-[640px]">
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="text-right">ความน่าจะเป็น</th>
              <th className="text-right">มูลค่า</th>
              <th className="text-right">Upside</th>
              <th className="text-right">Margin of safety</th>
              <th>หมายเหตุ</th>
            </tr>
          </thead>
          <tbody>
            {summary.scenarios.map((r, i) => (
              <tr key={r.scenarioId}>
                <td>
                  {derived ? (
                    r.name
                  ) : (
                    <input aria-label={`ชื่อ scenario ${i + 1}`} className="input w-28 py-0.5" value={scen[i]?.name ?? r.name} onChange={(e) => setScen(i, { name: e.target.value })} />
                  )}
                </td>
                <td className="text-right">
                  {derived ? (
                    fmtPct(r.probability, 1)
                  ) : (
                    <input
                      aria-label={`ความน่าจะเป็น ${r.name} (%)`}
                      className="input w-20 py-0.5 text-right"
                      inputMode="decimal"
                      defaultValue={Number((r.probability * 100).toFixed(6))}
                      key={`${r.scenarioId}-${r.probability}`}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) setScen(i, { probability: v / 100 });
                      }}
                    />
                  )}
                </td>
                <td className="text-right tabular-nums">{r.valuePerShare != null ? fmtNum(r.valuePerShare) : <span title={r.naReason ?? ""}>N/A</span>}</td>
                <td className={clsx("text-right tabular-nums", signClass(r.upsidePct))}>{r.upsidePct != null ? fmtPct(r.upsidePct, 1) : "N/A"}</td>
                <td className="text-right tabular-nums">{r.marginOfSafetyPct != null ? fmtPct(r.marginOfSafetyPct, 1) : <span title={r.naReason ?? ""}>N/A</span>}</td>
                <td className="max-w-[16rem] text-[11px]">
                  {r.errors.map((e) => (
                    <div key={e} className="text-neg">• {e}</div>
                  ))}
                  {r.warnings.slice(0, 2).map((w) => (
                    <div key={w} className="text-warn">• {w}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="text-muted">รวม</td>
              <td className={clsx("text-right tabular-nums", Math.abs(summary.sumProbability - 1) > 1e-8 && "text-neg")}>{fmtPct(summary.sumProbability, 2)}</td>
              <td className="text-right tabular-nums" colSpan={1}>
                {summary.probabilityWeightedValue != null ? fmtNum(summary.probabilityWeightedValue) : "—"}
              </td>
              <td className={clsx("text-right tabular-nums", signClass(summary.weightedUpsidePct))}>{summary.weightedUpsidePct != null ? fmtPct(summary.weightedUpsidePct, 1) : "—"}</td>
              <td className="text-right tabular-nums">{summary.weightedMarginOfSafetyPct != null ? fmtPct(summary.weightedMarginOfSafetyPct, 1) : "—"}</td>
              <td className="text-[11px] text-muted">ค่าถ่วงน้ำหนัก (เฉพาะเมื่อทุก scenario ที่มีความน่าจะเป็น &gt; 0 คำนวณได้)</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[11px] text-muted">Upside = มูลค่า ÷ ราคา − 1 · Margin of safety = (มูลค่า − ราคา) ÷ มูลค่า · ความน่าจะเป็นถ่วงเฉพาะ scenario ของวิธีนี้ ไม่ใช่การเฉลี่ยข้ามวิธี</p>
      {(summary.errors.length > 0 || summary.qualityReasons.length > 0 || summary.warnings.length > 0) && (
        <ul className="space-y-0.5 text-xs">
          {summary.errors.map((e) => (
            <li key={e} className="text-neg">• {e}</li>
          ))}
          {summary.qualityReasons.map((e) => (
            <li key={e} className="text-warn">• {e}</li>
          ))}
          {summary.warnings.map((e) => (
            <li key={e} className="text-muted">• {e}</li>
          ))}
        </ul>
      )}
      {!derived && Math.abs(summary.sumProbability - 1) > 1e-8 && (
        <div className="text-xs">
          <button type="button" className="btn-ghost text-xs" onClick={() => setProposal(proposeNormalised(scen))}>
            เสนอการปรับให้รวม 100%
          </button>
          {proposal && (
            <div className="mt-2 rounded-lg border border-border p-2">
              <p className="text-muted">ระบบจะเปลี่ยนเป็น (ยังไม่ใช้จนกว่าจะกดยืนยัน):</p>
              <ul>
                {proposal.map((p) => (
                  <li key={p.id} className="tabular-nums">
                    {p.id}: {fmtPct(p.from, 2)} → {fmtPct(p.to, 4)}
                  </li>
                ))}
              </ul>
              <button type="button" className="btn-ghost mt-1 text-xs" onClick={() => (update({ scenarios: scen.map((s) => ({ ...s, probability: proposal.find((p) => p.id === s.id)?.to ?? s.probability })) }), setProposal(null))}>
                ยืนยันใช้ค่าที่ปรับ
              </button>
            </div>
          )}
        </div>
      )}
      {values.length > 0 && <RangePlot summary={summary} />}
      {!derived && (
        <div className="space-y-2">
          {scen.map((s, i) => (
            <details key={s.id} className="rounded-lg border border-border px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium">
                สมมติฐานของ {s.name} ({Object.keys(s.inputOverrides ?? {}).length} รายการ)
              </summary>
              <OverrideEditor paths={opts} value={s.inputOverrides ?? {}} onChange={(o) => setScen(i, { inputOverrides: o })} />
              <label className="mt-2 block">
                <span className="label">เหตุผล (สมมติฐานของผู้ใช้)</span>
                <textarea className="input text-xs" rows={2} value={s.rationale ?? ""} onChange={(e) => setScen(i, { rationale: e.target.value || undefined })} />
              </label>
              <label className="mt-1 block">
                <span className="label">แหล่งข้อมูลเฉพาะ scenario (ลิงก์ วันที่ หน่วย)</span>
                <input className="input text-xs" value={s.sources ?? ""} onChange={(e) => setScen(i, { sources: e.target.value || undefined })} />
              </label>
              <button type="button" className="mt-2 text-[11px] text-neg underline" onClick={() => update({ scenarios: scen.filter((_, j) => j !== i) })}>
                ลบ scenario นี้
              </button>
            </details>
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                let n = scen.length + 1;
                while (scen.some((s) => s.id === `custom-${n}`)) n++;
                update({ scenarios: [...scen, { id: `custom-${n}`, name: `Custom ${n}`, probability: 0, inputOverrides: {} }] });
              }}
              disabled={scen.length >= 8}
            >
              + เพิ่ม scenario
            </button>
          </div>
        </div>
      )}
      <button type="button" className="text-[11px] text-muted underline" onClick={clear}>
        ล้าง scenario ทั้งหมด (มูลค่าฐานไม่เปลี่ยน)
      </button>
    </div>
  );
}

function OverrideEditor({ paths, value, onChange }: { paths: string[]; value: Record<string, number | string>; onChange: (v: Record<string, number | string>) => void }) {
  const [path, setPath] = useState("");
  const [text, setText] = useState("");
  const listId = useMemo(() => `paths-${Math.random().toString(36).slice(2, 8)}`, []);
  const v = parseVal(path, text);
  return (
    <div className="mt-2 space-y-1 text-xs">
      {Object.entries(value).map(([p, x]) => (
        <div key={p} className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate" title={VIRTUAL_DRIVERS[p.split(".").pop() ?? ""] ?? p}>
            {p}
          </code>
          <input
            aria-label={`ค่า ${p}`}
            className="input w-28 py-0.5 text-right"
            defaultValue={String(x)}
            onBlur={(e) => {
              const nv = parseVal(p, e.target.value);
              if (nv != null) onChange({ ...value, [p]: nv });
            }}
          />
          <button type="button" aria-label={`ลบ ${p}`} className="text-muted hover:text-neg" onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([k]) => k !== p)))}>
            ×
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="ตัวแปร (path)" list={listId} className="input min-w-0 flex-1 py-0.5" placeholder="เลือกหรือพิมพ์ path เช่น growthShift" value={path} onChange={(e) => setPath(e.target.value)} />
        <datalist id={listId}>
          {paths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <input aria-label="ค่าใหม่" className="input w-28 py-0.5 text-right" placeholder="0.02" value={text} onChange={(e) => setText(e.target.value)} />
        <button
          type="button"
          className="btn-ghost py-0.5 text-xs"
          disabled={!path || v == null}
          onClick={() => {
            onChange({ ...value, [path.trim()]: v! });
            setPath("");
            setText("");
          }}
        >
          เพิ่ม
        </button>
      </div>
      <p className="text-[11px] text-muted">อัตราใส่เป็นทศนิยม (0.02 = 2%) · *Shift = บวกเพิ่มจากค่าเดิม · segments[id].scenario = ใช้ scenario ของโมเดลส่วนงานนั้น</p>
    </div>
  );
}

/** Dot plot of scenario values against price, base and weighted value; the table above is the text alternative. */
function RangePlot({ summary }: { summary: ScenarioSummary }) {
  const pts = summary.scenarios.filter((s) => s.valuePerShare != null).map((s) => ({ label: s.name, v: s.valuePerShare! }));
  const all = [...pts.map((p) => p.v), summary.price ?? NaN, summary.baseCaseValue ?? NaN, summary.probabilityWeightedValue ?? NaN].filter(Number.isFinite);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
  const x = (v: number) => 12 + ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 376;
  const marker = (v: number | null, cls: string, label: string) =>
    v != null && (
      <g>
        <line x1={x(v)} x2={x(v)} y1={6} y2={42} className={cls} strokeWidth={1.5} strokeDasharray={label === "ราคา" ? "3 3" : undefined} />
        <text x={x(v)} y={54} textAnchor="middle" className="fill-muted text-[9px]">
          {label}
        </text>
      </g>
    );
  return (
    <figure className="min-w-0">
      <svg viewBox="0 0 400 60" className="h-16 w-full" role="img" aria-label={`ช่วงมูลค่า scenario ${pts.map((p) => `${p.label} ${p.v.toFixed(2)}`).join(", ")} เทียบราคา ${summary.price ?? "—"}`}>
        <line x1={12} x2={388} y1={24} y2={24} className="stroke-border" />
        {marker(summary.price, "stroke-muted", "ราคา")}
        {marker(summary.probabilityWeightedValue, "stroke-accent", "ถ่วงน้ำหนัก")}
        {pts.map((p) => (
          <g key={p.label}>
            <circle cx={x(p.v)} cy={24} r={4.5} className="fill-accent/70 stroke-accent" />
            <text x={x(p.v)} y={14} textAnchor="middle" className="fill-text text-[9px]">
              {p.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="text-[11px] text-muted">จุด = มูลค่าแต่ละ scenario · เส้นประ = ราคาตลาด · เส้นสีหลัก = ค่าถ่วงน้ำหนัก</figcaption>
    </figure>
  );
}

function AxisEditor({ label, axis, onChange, paths }: { label: string; axis: SensitivityConfig["x"]; onChange: (a: SensitivityConfig["x"]) => void; paths: string[] }) {
  const id = `ax-${label}`;
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <label className="min-w-0 flex-1">
        <span className="label">แกน {label}</span>
        <input className="input py-0.5" list={id} value={axis.path} onChange={(e) => onChange({ ...axis, path: e.target.value })} />
        <datalist id={id}>
          {["discountRate", ...paths].map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </label>
      <label>
        <span className="label">แบบ</span>
        <select className="input py-0.5" value={axis.mode} onChange={(e) => onChange({ ...axis, mode: e.target.value as SensitivityConfig["x"]["mode"] })}>
          <option value="shift">± จากฐาน</option>
          <option value="absolute">ค่าจริง</option>
          <option value="pct">% จากฐาน</option>
        </select>
      </label>
      <label className="min-w-0 flex-1">
        <span className="label">ค่า (คั่นด้วย ,)</span>
        <input className="input py-0.5" defaultValue={axis.values.join(", ")} onBlur={(e) => onChange({ ...axis, values: parseList(e.target.value).slice(0, 11) })} />
      </label>
    </div>
  );
}

function SensitivityTab({ input }: { input: ValuationInput }) {
  const def = useMemo(() => defaultSensitivity(input), [input.method]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cfg, setCfg] = useState<SensitivityConfig | null>("unsupported" in def ? null : def);
  const paths = useMemo(() => pathOptions(input).filter((p) => !p.endsWith("scenario")), [input]);
  const grid: SensitivityResult | null = useMemo(() => {
    if (!cfg) return null;
    try {
      return sensitivityGrid(input, cfg);
    } catch {
      return null;
    }
  }, [input, cfg]);
  if (!cfg) return <p className="text-xs text-muted">{"unsupported" in def ? def.unsupported : ""}</p>;
  const maxAbs = Math.max(1e-12, ...(grid?.cells.flat().map((c) => Math.abs(c.deltaPct ?? 0)) ?? [0]));
  return (
    <div className="space-y-3">
      <AxisEditor label="x" axis={cfg.x} paths={paths} onChange={(x) => setCfg({ ...cfg, x })} />
      {cfg.y ? (
        <AxisEditor label="y" axis={cfg.y} paths={paths} onChange={(y) => setCfg({ ...cfg, y })} />
      ) : (
        <button type="button" className="btn-ghost text-xs" onClick={() => setCfg({ ...cfg, y: { path: paths[0] ?? "terminalGrowth", mode: "shift", values: [-0.01, 0, 0.01] } })}>
          + แกน y
        </button>
      )}
      {grid && (
        <>
          <div className="overflow-x-auto">
            <table className="table text-xs" aria-label={`Sensitivity ${grid.x.label}${grid.y ? ` × ${grid.y.label}` : ""}`}>
              <thead>
                <tr>
                  <th>{grid.y ? `${grid.y.path} ↓ / ${grid.x.path} →` : grid.x.path}</th>
                  {cfg.x.values.map((v) => (
                    <th key={v} className="text-right tabular-nums">
                      {fmtAxis(v, cfg.x)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.cells.map((row, i) => (
                  <tr key={i}>
                    <th className="text-left font-normal tabular-nums">{grid.y ? fmtAxis(row[0].y!, cfg.y!) : "มูลค่า"}</th>
                    {row.map((c, j) => (
                      <td
                        key={j}
                        title={c.error ?? (c.deltaPct != null ? `${fmtPct(c.deltaPct, 1)} จากฐาน` : "")}
                        className={clsx("text-right tabular-nums", c.value == null && "text-muted")}
                        style={c.deltaPct != null ? { background: `color-mix(in oklab, var(--${c.deltaPct >= 0 ? "pos" : "neg"}) ${Math.round((Math.abs(c.deltaPct) / maxAbs) * 28)}%, transparent)` } : undefined}
                      >
                        {c.value != null ? fmtNum(c.value) : "N/A"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted">
            ฐาน {fmtNum(grid.baseValue)} · ช่อง N/A = คำนวณไม่ได้ (วางเมาส์ดูเหตุผล) · สีแสดง % เปลี่ยนจากฐาน · sensitivity ≠ ความน่าจะเป็น
          </p>
          {[...grid.errors, ...grid.notes].map((e) => (
            <p key={e} className="text-xs text-warn">• {e}</p>
          ))}
        </>
      )}
    </div>
  );
}

const fmtAxis = (v: number, ax: SensitivityConfig["x"]) =>
  ax.mode === "pct" ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%` : Math.abs(v) < 1 && ax.path !== "yieldShiftBp" ? `${ax.mode === "shift" && v > 0 ? "+" : ""}${(v * 100).toFixed(2)}%` : `${ax.mode === "shift" && v > 0 ? "+" : ""}${v}`;

function ReverseTab({ input }: { input: ValuationInput }) {
  const def = useMemo(() => defaultReverse(input), [input.method]); // eslint-disable-line react-hooks/exhaustive-deps
  const [cfg, setCfg] = useState<ReverseConfig | null>("unsupported" in def ? null : def);
  const [res, setRes] = useState<ReverseResult | null>(null);
  if (!cfg) return <p className="text-xs text-muted">{"unsupported" in def ? def.unsupported : ""}</p>;
  const price = (input.assumptions as { currentPrice?: number }).currentPrice;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="label">ตัวแปรที่จะหา</span>
          <input className="input py-0.5" list="rev-paths" value={cfg.path} onChange={(e) => setCfg({ ...cfg, path: e.target.value })} />
          <datalist id="rev-paths">
            {pathOptions(input)
              .filter((p) => !p.endsWith("scenario"))
              .map((p) => (
                <option key={p} value={p} />
              ))}
          </datalist>
        </label>
        <label>
          <span className="label">ต่ำสุด</span>
          <input className="input w-20 py-0.5" defaultValue={cfg.lo} onBlur={(e) => setCfg({ ...cfg, lo: Number(e.target.value) })} />
        </label>
        <label>
          <span className="label">สูงสุด</span>
          <input className="input w-20 py-0.5" defaultValue={cfg.hi} onBlur={(e) => setCfg({ ...cfg, hi: Number(e.target.value) })} />
        </label>
        <label>
          <span className="label">ราคาเป้าหมาย</span>
          <input className="input w-24 py-0.5" placeholder={String(price ?? "")} defaultValue={cfg.targetPrice ?? ""} onBlur={(e) => setCfg({ ...cfg, targetPrice: e.target.value ? Number(e.target.value) : undefined })} />
        </label>
        <button type="button" className="btn-ghost text-xs" onClick={() => setRes(reverseSolve(input, cfg))}>
          คำนวณ
        </button>
      </div>
      <p className="text-[11px] text-muted">หาค่าเดียวที่ทำให้มูลค่าจากแบบจำลองเท่ากับราคาตลาด โดยคงสมมติฐานอื่นทั้งหมด — เป็นเงื่อนไขของสมมติฐานเหล่านั้น ไม่ใช่การพยากรณ์การเติบโต</p>
      {res && (
        <div className="rounded-lg border border-border p-3" role="status">
          {res.status === "solved" ? (
            <>
              <div className="text-[11px] text-muted">{res.path} โดยนัยจากราคา {fmtNum(res.targetPrice)}</div>
              <div className="text-[22px] font-semibold tabular-nums">{Math.abs(res.solution!) < 1.5 ? fmtPct(res.solution!, 2) : fmtNum(res.solution!)}</div>
              <div className="text-[11px] text-muted tabular-nums">
                มูลค่าที่ได้ {fmtNum(res.modeledPrice)} · ส่วนต่าง {res.residual?.toExponential(2)} · {res.iterations} รอบ · ช่วง {res.bracket?.map((b) => b.toFixed(4)).join("–")}
              </div>
            </>
          ) : (
            <div className="text-warn">{res.status === "unsupported" ? "ไม่รองรับ" : res.status === "ambiguous" ? "มีหลายคำตอบ" : "ไม่มีคำตอบในช่วงนี้"}</div>
          )}
          {res.messages.map((m) => (
            <p key={m} className="mt-1 text-[11px] text-muted">• {m}</p>
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_DIST: Record<DistributionSpec["type"], DistributionSpec> = {
  uniform: { type: "uniform", min: -0.01, max: 0.01 },
  triangular: { type: "triangular", min: -0.02, mode: 0, max: 0.02 },
  normal: { type: "normal", mean: 0, sd: 0.01, min: -0.03, max: 0.03 },
  empirical: { type: "empirical", samples: [], source: "" },
};

function MonteCarloTab({ input, set, update }: { input: ValuationInput; set?: ScenarioSet; update: (p: Partial<ScenarioSet>) => void }) {
  const cfg = set?.monteCarlo;
  const paths = useMemo(() => pathOptions(input).filter((p) => !p.endsWith("scenario")), [input]);
  const [res, setRes] = useState<MonteCarloResult | { error: string } | null>(null);
  const [pending, start] = useTransition();
  const setCfg = (c: Partial<MonteCarloConfig> | undefined) => update({ monteCarlo: c ? ({ seed: 20261027, draws: 2000, maxInvalidShare: 0.2, timeBudgetMs: 8000, variables: [], ...(cfg ?? {}), ...c } as MonteCarloConfig) : undefined });
  if (!cfg)
    return (
      <div className="space-y-2 text-xs">
        <p className="text-muted">ไม่บังคับ — สุ่มค่าตัวแปรตามการแจกแจงที่คุณกำหนด แล้วคำนวณมูลค่าด้วยโมเดลเดียวกันทุกรอบ (seed คงที่ ทำซ้ำได้)</p>
        <button type="button" className="btn-ghost text-xs" onClick={() => setCfg({ variables: [defaultMonteCarloVariable(input)] })}>
          เปิดใช้ Monte Carlo
        </button>
      </div>
    );
  const vars = cfg.variables;
  // Editing a variable keeps the correlation matrix (same row); add / remove resizes it without touching other pairs.
  const setVar = (i: number, v: MonteCarloConfig["variables"][number]) => setCfg({ variables: vars.map((x, j) => (j === i ? v : x)) });
  const corrCheck = cfg.correlation ? checkCorrelation(cfg.correlation, vars.length) : null;
  const corrBlocked = !!corrCheck && (corrCheck.errors.length > 0 || !corrCheck.psd);
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-end gap-2">
        <label>
          <span className="label">Seed</span>
          <input className="input w-28 py-0.5" defaultValue={cfg.seed} onBlur={(e) => setCfg({ seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
        </label>
        <label>
          <span className="label">จำนวนรอบ (≤ 10,000)</span>
          <input className="input w-24 py-0.5" defaultValue={cfg.draws} onBlur={(e) => setCfg({ draws: Math.min(10_000, Math.max(100, Math.floor(Number(e.target.value) || 2000))) })} />
        </label>
        <button type="button" className="btn-ghost text-xs" disabled={pending || !vars.length || corrBlocked} title={corrBlocked ? "แก้ correlation ให้ถูกต้องก่อน" : undefined} onClick={() => start(async () => {
          const r = await analyzeValuationAction({ valuation: input, monteCarlo: cfg });
          setRes(r.ok ? r.result.monteCarlo : { error: r.error });
        })}>
          {pending ? "กำลังจำลอง…" : "จำลอง (บนเซิร์ฟเวอร์)"}
        </button>
        <button type="button" className="text-[11px] text-muted underline" onClick={() => (setCfg(undefined), setRes(null))}>
          ปิด Monte Carlo
        </button>
      </div>
      {vars.map((v, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-2">
          <label className="min-w-0 flex-1">
            <span className="label">ตัวแปร</span>
            <input className="input py-0.5" list="mc-paths" value={v.path} onChange={(e) => setVar(i, { ...v, path: e.target.value })} />
          </label>
          <label>
            <span className="label">แบบ</span>
            <select className="input py-0.5" value={v.mode} onChange={(e) => setVar(i, { ...v, mode: e.target.value as "shift" | "absolute" })}>
              <option value="absolute">ค่าจริง</option>
              <option value="shift">± จากฐาน</option>
            </select>
          </label>
          <label>
            <span className="label">การแจกแจง</span>
            <select className="input py-0.5" value={v.dist.type} onChange={(e) => setVar(i, { ...v, dist: DEFAULT_DIST[e.target.value as DistributionSpec["type"]] })}>
              <option value="triangular">triangular</option>
              <option value="uniform">uniform</option>
              <option value="normal">normal (ตัดช่วง)</option>
              <option value="empirical">empirical (ข้อมูลจริง)</option>
            </select>
          </label>
          <DistFields d={v.dist} onChange={(dist) => setVar(i, { ...v, dist })} />
          <button type="button" aria-label="ลบตัวแปร" className="text-muted hover:text-neg" onClick={() => setCfg({ variables: vars.filter((_, j) => j !== i), correlation: removeCorrelationIndex(cfg.correlation, i) })}>
            ×
          </button>
        </div>
      ))}
      <datalist id="mc-paths">
        {paths.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {vars.length < 8 && (
        <button type="button" className="btn-ghost text-xs" onClick={() => setCfg({ variables: [...vars, { path: "", mode: "absolute", dist: DEFAULT_DIST.uniform }], correlation: appendCorrelationIndex(cfg.correlation) })}>
          + ตัวแปร
        </button>
      )}
      <p className="text-[11px] text-muted">ตัวแปร *Shift (growthShift, roeShift, yieldShiftBp) เป็นส่วนเพิ่มอยู่แล้ว · “± จากฐาน” = บวกค่าที่สุ่มเข้ากับค่าเดิม</p>
      <CorrelationEditor
        paths={vars.map((v) => v.path || "(ยังไม่ระบุ)")}
        value={cfg.correlation}
        check={corrCheck}
        onChange={(correlation) => setCfg({ correlation })}
      />
      {res && ("error" in res ? <p className="text-neg">{res.error}</p> : <McResult r={res} />)}
    </div>
  );
}

/**
 * Dependence between Monte Carlo variables: independent, or a manual correlation matrix (Gaussian
 * copula). Upper-triangle edits are mirrored; the diagonal is fixed at 1. A non-PSD matrix is never
 * repaired silently: the repaired matrix is shown and applied only after confirmation.
 */
function CorrelationEditor({
  paths,
  value,
  check,
  onChange,
}: {
  paths: string[];
  value: number[][] | undefined;
  check: ReturnType<typeof checkCorrelation> | null;
  onChange: (c: number[][] | undefined) => void;
}) {
  const n = paths.length;
  const [showRepair, setShowRepair] = useState(false);
  const manual = !!value;
  return (
    <fieldset className="min-w-0 rounded-lg border border-border p-2">
      <legend className="px-1 text-[11px] font-medium">การพึ่งพากัน / Correlation</legend>
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-1">
          <input type="radio" name="mc-dependence" checked={!manual} onChange={() => onChange(undefined)} />
          ตัวแปรอิสระต่อกัน
        </label>
        <label className={clsx("flex items-center gap-1", n < 2 && "opacity-50")}>
          <input type="radio" name="mc-dependence" checked={manual} disabled={n < 2} onChange={() => onChange(identityCorrelation(n))} />
          กำหนด correlation เอง {n < 2 && "(ต้องมี ≥ 2 ตัวแปร)"}
        </label>
      </div>
      {manual && value && (
        <div className="mt-2 space-y-2">
          <div className="overflow-x-auto">
            <table className="table text-[11px]" aria-label="Correlation matrix">
              <thead>
                <tr>
                  <th />
                  {paths.map((p, j) => (
                    <th key={j} className="max-w-[9rem] truncate text-right font-normal normal-case" title={p}>
                      {j + 1}. {p}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paths.map((p, i) => (
                  <tr key={i}>
                    <th className="max-w-[10rem] truncate text-left font-normal normal-case" title={p}>
                      {i + 1}. {p}
                    </th>
                    {paths.map((_, j) =>
                      i === j ? (
                        <td key={j} className="text-right tabular-nums text-muted">
                          1
                        </td>
                      ) : j > i ? (
                        <td key={j} className="text-right">
                          <input
                            aria-label={`correlation ${i + 1} กับ ${j + 1}`}
                            className={clsx("input w-16 py-0.5 text-right", !(Math.abs(value[i]?.[j] ?? 0) <= 1) && "border-neg")}
                            inputMode="decimal"
                            defaultValue={Number((value[i]?.[j] ?? 0).toFixed(4))}
                            key={`${i}-${j}-${value[i]?.[j]}`}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v)) onChange(setCorrelationPair(value, i, j, v));
                            }}
                          />
                        </td>
                      ) : (
                        <td key={j} className="text-right tabular-nums text-muted" title="สะท้อนจากช่องด้านบน (สมมาตร)">
                          {(value[i]?.[j] ?? 0).toFixed(2)}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {check?.errors.map((e) => (
            <p key={e} className="text-neg" role="alert">
              • {e}
            </p>
          ))}
          {check && !check.errors.length && check.psd && <p className="text-[11px] text-pos">ผ่านการตรวจ: สมมาตร แนวทแยง = 1 และ positive semidefinite (eigenvalue ต่ำสุด {check.minEigenvalue?.toFixed(4)})</p>}
          {check && !check.errors.length && !check.psd && (
            <div className="rounded-lg border border-warn/40 p-2 text-warn" role="alert">
              <p>
                เมทริกซ์นี้ไม่เป็น positive semidefinite (eigenvalue ต่ำสุด {check.minEigenvalue?.toFixed(4)}) — ค่าชุดนี้ขัดกันเอง เช่น A สัมพันธ์บวกกับ B และ C แต่ B กับ C สัมพันธ์ลบมาก · ยังจำลองไม่ได้จนกว่าจะแก้ค่าเองหรือยืนยันใช้ค่าที่ซ่อม
              </p>
              <button type="button" className="btn-ghost mt-1 text-xs" onClick={() => setShowRepair((x) => !x)}>
                {showRepair ? "ซ่อนค่าที่ซ่อม" : "ดูค่าที่ระบบเสนอให้ซ่อม"}
              </button>
              {showRepair && check.repaired && (
                <div className="mt-2 text-muted">
                  <p>ปรับ eigenvalue ที่ติดลบเป็น 0 แล้วปรับแนวทแยงกลับเป็น 1 (ค่าที่เปลี่ยน):</p>
                  <ul className="tabular-nums">
                    {check.repaired.flatMap((row, i) =>
                      row
                        .map((x, j) => ({ i, j, from: value[i][j], to: x }))
                        .filter((c) => c.j > c.i)
                        .map((c) => (
                          <li key={`${c.i}-${c.j}`}>
                            {c.i + 1}–{c.j + 1}: {c.from.toFixed(3)} → {c.to.toFixed(3)}
                          </li>
                        )),
                    )}
                  </ul>
                  <button
                    type="button"
                    className="btn-ghost mt-1 text-xs"
                    onClick={() => {
                      onChange(check.repaired!);
                      setShowRepair(false);
                    }}
                  >
                    ยืนยันใช้ค่าที่ซ่อมแล้ว
                  </button>
                </div>
              )}
            </div>
          )}
          <p className="text-[11px] text-muted">Gaussian copula: ρ คือ correlation ของตัวแปรปกติที่ใช้สุ่ม (ไม่ใช่ correlation ของค่าที่ได้ตรง ๆ) · ใส่ตามเหตุผลทางธุรกิจ — ระบบไม่ประมาณจากราคาหุ้น</p>
        </div>
      )}
    </fieldset>
  );
}

function DistFields({ d, onChange }: { d: DistributionSpec; onChange: (d: DistributionSpec) => void }) {
  const num = (k: string, label: string, v: number | undefined) => (
    <label key={k}>
      <span className="label">{label}</span>
      <input
        className="input w-20 py-0.5"
        defaultValue={v ?? ""}
        onBlur={(e) => {
          const x = e.target.value.trim() === "" ? undefined : Number(e.target.value);
          if (x === undefined || Number.isFinite(x)) onChange({ ...d, [k]: x } as DistributionSpec);
        }}
      />
    </label>
  );
  if (d.type === "uniform") return <>{[num("min", "min", d.min), num("max", "max", d.max)]}</>;
  if (d.type === "triangular") return <>{[num("min", "min", d.min), num("mode", "mode", d.mode), num("max", "max", d.max)]}</>;
  if (d.type === "normal") return <>{[num("mean", "mean", d.mean), num("sd", "sd", d.sd), num("min", "ตัดล่าง", d.min), num("max", "ตัดบน", d.max)]}</>;
  return (
    <>
      <label className="min-w-0 flex-1">
        <span className="label">ข้อมูลที่สังเกตได้ (≥ 20 ค่า)</span>
        <input className="input py-0.5" defaultValue={d.samples.join(", ")} onBlur={(e) => onChange({ ...d, samples: parseList(e.target.value) })} />
      </label>
      <label className="min-w-0 flex-1">
        <span className="label">แหล่งที่มา (จำเป็น)</span>
        <input className="input py-0.5" defaultValue={d.source} onBlur={(e) => onChange({ ...d, source: e.target.value })} />
      </label>
    </>
  );
}

function McResult({ r }: { r: MonteCarloResult }) {
  const p = r.percentiles;
  const lo = r.histogram[0]?.from ?? 0;
  const hi = r.histogram[r.histogram.length - 1]?.to ?? 1;
  const x = (v: number) => 8 + ((v - lo) / (hi - lo || 1)) * 384;
  const maxC = Math.max(1, ...r.histogram.map((h) => h.count));
  return (
    <div className="space-y-2" role="status">
      <div className={clsx("text-[11px]", r.usable ? "text-muted" : "text-neg")}>
        {r.usable ? "ใช้ได้" : "ผลใช้ไม่ได้"} · {r.valid.toLocaleString()} จาก {r.drawsRun.toLocaleString()} รอบใช้ได้ ({fmtPct(r.invalidShare, 1)} คำนวณไม่ได้) · seed {r.seed} · {r.elapsedMs} ms
        {r.timedOut && " · หยุดเพราะครบเวลา"}
      </div>
      {r.histogram.length > 0 && (
        <figure>
          <svg viewBox="0 0 400 90" className="h-24 w-full" role="img" aria-label={`ฮิสโทแกรมมูลค่าที่จำลอง P10 ${fmtNum(p.p10)} P50 ${fmtNum(p.p50)} P90 ${fmtNum(p.p90)}`}>
            {r.histogram.map((h, i) => (
              <rect key={i} x={x(h.from)} width={Math.max(1, x(h.to) - x(h.from) - 1)} y={62 - (h.count / maxC) * 56} height={(h.count / maxC) * 56} className="fill-accent/50" />
            ))}
            {p.p10 != null && p.p90 != null && <rect x={x(p.p10)} width={x(p.p90) - x(p.p10)} y={70} height={6} rx={3} className="fill-accent/30" />}
            {p.p50 != null && <rect x={x(p.p50) - 1} width={2} y={66} height={14} className="fill-accent" />}
            {r.price != null && r.price >= lo && r.price <= hi && <line x1={x(r.price)} x2={x(r.price)} y1={0} y2={84} className="stroke-muted" strokeDasharray="3 3" />}
          </svg>
          <figcaption className="text-[11px] text-muted">แท่ง = จำนวนรอบในแต่ละช่วงมูลค่า · แถบล่าง = P10–P90 · ขีด = P50 · เส้นประ = ราคาตลาด</figcaption>
        </figure>
      )}
      <table className="table text-xs">
        <tbody>
          <tr>
            <th className="text-left font-normal">P5 / P10 / P25</th>
            <td className="text-right tabular-nums">{[p.p5, p.p10, p.p25].map((v) => fmtNum(v)).join(" / ")}</td>
          </tr>
          <tr>
            <th className="text-left font-normal">P50 (มัธยฐาน) / ค่าเฉลี่ย / SD</th>
            <td className="text-right tabular-nums">{[p.p50, r.mean, r.sd].map((v) => fmtNum(v)).join(" / ")}</td>
          </tr>
          <tr>
            <th className="text-left font-normal">P75 / P90 / P95</th>
            <td className="text-right tabular-nums">{[p.p75, p.p90, p.p95].map((v) => fmtNum(v)).join(" / ")}</td>
          </tr>
          {r.probAbovePrice != null && (
            <tr>
              <th className="text-left font-normal">สัดส่วนผลจำลองที่สูงกว่าราคา</th>
              <td className="text-right tabular-nums">{fmtPct(r.probAbovePrice, 1)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {[...r.errors, ...r.warnings, ...r.invalidReasons.map((x) => `คำนวณไม่ได้ ${x.count} รอบ: ${x.reason}`)].map((w) => (
        <p key={w} className="text-[11px] text-muted">• {w}</p>
      ))}
    </div>
  );
}

function NotesTab({ input, set, summary, update }: { input: ValuationInput; set?: ScenarioSet; summary: ScenarioSummary | null; update: (p: Partial<ScenarioSet>) => void }) {
  const [diffFor, setDiffFor] = useState<string | null>(null);
  if (!summary) return <p className="text-xs text-muted">เพิ่ม scenario ก่อน แล้วระบบจะร่างคำอธิบายภาษาไทยให้แก้ไขได้</p>;
  const stored = set?.scenarios ?? [];
  const saveNote = (r: ScenarioSummary["scenarios"][number], noteTh: string | undefined) => {
    const exists = stored.some((s) => s.id === r.scenarioId);
    update({
      scenarios: exists
        ? stored.map((s) => (s.id === r.scenarioId ? { ...s, noteTh } : s))
        : [...stored, { id: r.scenarioId, name: r.name, probability: r.probability, inputOverrides: {}, noteTh }],
    });
  };
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted">ร่างสร้างจากตัวเลขและแหล่งที่มาในข้อมูลนำเข้าเท่านั้น · ข้อความที่คุณแก้จะถูกบันทึกและไม่ถูกเขียนทับอัตโนมัติ</p>
      {summary.scenarios.map((r) => {
        const generated = generateScenarioNoteTh(input, summary, r);
        const mine = stored.find((s) => s.id === r.scenarioId)?.noteTh;
        const d = mine ? lineDiff(mine, generated) : null;
        return (
          <div key={r.scenarioId} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{r.name}</span>
              {!mine ? (
                <button type="button" className="btn-ghost py-0.5 text-xs" onClick={() => saveNote(r, generated)}>
                  ใช้ร่างที่สร้าง
                </button>
              ) : (
                d && (d.added.length > 0 || d.removed.length > 0) && (
                  <button type="button" className="btn-ghost py-0.5 text-xs" onClick={() => setDiffFor(diffFor === r.scenarioId ? null : r.scenarioId)}>
                    ร่างใหม่ต่างจากที่บันทึก ({d.added.length + d.removed.length} บรรทัด)
                  </button>
                )
              )}
            </div>
            {diffFor === r.scenarioId && d && (
              <div className="rounded-lg border border-border p-2 text-[11px]">
                {d.removed.map((l) => (
                  <div key={`-${l}`} className="text-neg">− {l}</div>
                ))}
                {d.added.map((l) => (
                  <div key={`+${l}`} className="text-pos">+ {l}</div>
                ))}
                <button type="button" className="btn-ghost mt-1 text-xs" onClick={() => (saveNote(r, generated), setDiffFor(null))}>
                  แทนที่ด้วยร่างใหม่
                </button>
              </div>
            )}
            <textarea
              aria-label={`คำอธิบาย ${r.name}`}
              className="input font-sans text-xs leading-relaxed"
              rows={mine ? 10 : 6}
              value={mine ?? ""}
              placeholder={generated}
              onChange={(e) => saveNote(r, e.target.value || undefined)}
            />
          </div>
        );
      })}
    </div>
  );
}
