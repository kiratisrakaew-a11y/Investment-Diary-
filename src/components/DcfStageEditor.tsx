"use client";

import clsx from "clsx";
import { forecastYears, yearDrivers, type DcfAssumptions, type DcfStage } from "@/lib/finance/valuation";
import { fmtPct } from "@/lib/format";

const STAGE_COLORS = ["var(--series-1)", "var(--series-5)", "var(--series-3)", "var(--series-4)"];
const STAGE_NAMES = ["High growth", "Transition", "Mature", "Stage 4"];

/**
 * Example stage layouts (not recommendations). Values are cut from the user's current linear fade
 * (growthStart → growthEnd, margin start → end), so switching mode starts from their own numbers.
 */
export const STAGE_PRESETS: { key: string; label: string; years: number[] }[] = [
  { key: "5y", label: "ตัวอย่าง 5 ปี (2+2+1)", years: [2, 2, 1] },
  { key: "10y", label: "ตัวอย่าง 10 ปี (3+4+3)", years: [3, 4, 3] },
];

export function stagesFromFade(a: DcfAssumptions, years: number[]): DcfStage[] {
  const n = years.reduce((s, y) => s + y, 0);
  const at = (from: number, to: number, i: number) => (n <= 1 ? to : from + ((to - from) * i) / (n - 1));
  let start = 0;
  return years.map((y, k) => {
    const s0 = start;
    const s1 = start + y - 1;
    start += y;
    return {
      name: STAGE_NAMES[k],
      years: y,
      revenueGrowthStart: at(a.growthStart, a.growthEnd, s0),
      revenueGrowthEnd: at(a.growthStart, a.growthEnd, s1),
      ebitMarginStart: at(a.ebitMarginStart, a.ebitMarginEnd, s0),
      ebitMarginEnd: at(a.ebitMarginStart, a.ebitMarginEnd, s1),
    };
  });
}

type NumKey = "revenueGrowthStart" | "revenueGrowthEnd" | "ebitMarginStart" | "ebitMarginEnd" | "capexPct" | "daPct" | "nwcPct" | "taxRate" | "debtFinancingRatio";

export function DcfStageEditor({ a, model, setA, errors }: { a: DcfAssumptions; model: "fcff" | "fcfe"; setA: (f: (a: DcfAssumptions) => DcfAssumptions) => void; errors: string[] }) {
  const staged = a.forecastMode === "staged";
  const stages = a.stages ?? [];
  const total = forecastYears(a);

  const setMode = (m: "linear_fade" | "staged") =>
    setA((x) => (m === "staged" ? { ...x, forecastMode: "staged", stages: x.stages?.length ? x.stages : stagesFromFade(x, [3, 4, 3]), years: x.stages?.length ? forecastYears({ ...x, forecastMode: "staged" }) : 10 } : { ...x, forecastMode: "linear_fade" }));
  const sync = (st: DcfStage[]) => setA((x) => ({ ...x, stages: st, years: st.reduce((s, y) => s + y.years, 0) || x.years }));
  const setStage = (k: number, patch: Partial<DcfStage>) => sync(stages.map((s, j) => (j === k ? { ...s, ...patch } : s)));
  const optional: { key: NumKey; label: string; base: number }[] = [
    { key: "capexPct", label: "Capex", base: a.capexPct },
    { key: "daPct", label: "D&A", base: a.daPct },
    { key: "nwcPct", label: "NWC", base: a.nwcPct },
    { key: "taxRate", label: "ภาษี", base: a.taxRate },
    ...(model === "fcfe" ? [{ key: "debtFinancingRatio" as NumKey, label: "δ", base: a.debtFinancingRatio }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="รูปแบบประมาณการ" className="inline-flex rounded-xl border border-border bg-panel-2 p-0.5 text-sm">
          {(
            [
              ["linear_fade", "Legacy fade"],
              ["staged", "3-stage DCF"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={(m === "staged") === staged}
              onClick={() => setMode(m)}
              className={clsx("rounded-lg px-3 py-1 transition-colors", (m === "staged") === staged ? "bg-accent text-accent-ink" : "text-muted hover:text-fg")}
            >
              {label}
            </button>
          ))}
        </div>
        {staged && (
          <>
            {STAGE_PRESETS.map((p) => (
              <button key={p.key} type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => sync(stagesFromFade(a, p.years))} title="แบ่งเส้น fade ปัจจุบันเป็นช่วง — เป็นโครงตัวอย่าง ปรับตัวเลขเอง">
                {p.label}
              </button>
            ))}
            <span className="text-xs text-muted">รวม {total} ปี · โครงตัวอย่างตัดจากเส้น fade ที่ตั้งไว้ ไม่ใช่คำแนะนำ</span>
          </>
        )}
      </div>

      {staged && (
        <>
          <StageTimeline a={a} />
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>ช่วง</th>
                  <th className="num">ปี</th>
                  <th className="num">Growth เริ่ม→จบ (%)</th>
                  <th className="num">EBIT margin เริ่ม→จบ (%)</th>
                  {optional.map((o) => (
                    <th key={o.key} className="num" title="ว่าง = ใช้ค่าหลัก">
                      {o.label} (%)
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {stages.map((s, k) => (
                  <tr key={k}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STAGE_COLORS[k] }} aria-hidden />
                        <input aria-label={`ชื่อช่วงที่ ${k + 1}`} className="input w-28 py-1 text-xs" value={s.name ?? ""} placeholder={`ช่วงที่ ${k + 1}`} onChange={(e) => setStage(k, { name: e.target.value })} />
                      </div>
                    </td>
                    <td className="num">
                      <input
                        aria-label={`จำนวนปีช่วงที่ ${k + 1}`}
                        className="input w-12 py-1 text-right text-xs tabular-nums"
                        inputMode="numeric"
                        value={s.years}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isFinite(n)) setStage(k, { years: n });
                        }}
                      />
                    </td>
                    <td className="num">
                      <div className="flex justify-end gap-1">
                        <Pct label={`growth เริ่ม ช่วง ${k + 1}`} value={s.revenueGrowthStart} onChange={(v) => setStage(k, { revenueGrowthStart: v ?? 0 })} />
                        <Pct label={`growth จบ ช่วง ${k + 1}`} value={s.revenueGrowthEnd} onChange={(v) => setStage(k, { revenueGrowthEnd: v ?? 0 })} />
                      </div>
                    </td>
                    <td className="num">
                      <div className="flex justify-end gap-1">
                        <Pct label={`margin เริ่ม ช่วง ${k + 1}`} value={s.ebitMarginStart} onChange={(v) => setStage(k, { ebitMarginStart: v ?? 0 })} />
                        <Pct label={`margin จบ ช่วง ${k + 1}`} value={s.ebitMarginEnd} onChange={(v) => setStage(k, { ebitMarginEnd: v ?? 0 })} />
                      </div>
                    </td>
                    {optional.map((o) => (
                      <td key={o.key} className="num">
                        <Pct
                          label={`${o.label} ช่วง ${k + 1}`}
                          value={s[o.key]}
                          placeholder={fmtPct(o.base, 1)}
                          onChange={(v) => {
                            const next = { ...s };
                            if (v == null) delete next[o.key];
                            else next[o.key] = v;
                            sync(stages.map((x, j) => (j === k ? next : x)));
                          }}
                        />
                      </td>
                    ))}
                    <td>
                      <button type="button" className="text-xs text-muted hover:text-neg disabled:opacity-40" disabled={stages.length <= 2} onClick={() => sync(stages.filter((_, j) => j !== k))} aria-label={`ลบช่วงที่ ${k + 1}`}>
                        ลบ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              disabled={stages.length >= 4}
              onClick={() => {
                const last = stages[stages.length - 1];
                sync([...stages, { name: STAGE_NAMES[stages.length], years: 2, revenueGrowthStart: last?.revenueGrowthEnd ?? a.terminalGrowth, revenueGrowthEnd: a.terminalGrowth, ebitMarginStart: last?.ebitMarginEnd ?? a.ebitMarginEnd, ebitMarginEnd: last?.ebitMarginEnd ?? a.ebitMarginEnd }]);
              }}
            >
              + เพิ่มช่วง
            </button>
            <span className="text-xs text-muted">2–4 ช่วง · รวม 1–20 ปี · ค่าเปลี่ยนเป็นเส้นตรงภายในแต่ละช่วง · ช่องว่าง = ใช้ค่าหลักด้านล่าง</span>
          </div>
          {errors.length > 0 && (
            <ul className="space-y-0.5 text-xs text-neg" role="alert">
              {errors.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** Stage blocks proportional to years, with the per-year growth / margin path drawn over them. */
function StageTimeline({ a }: { a: DcfAssumptions }) {
  const d = yearDrivers(a);
  if (!d.length) return null;
  const W = 600;
  const H = 96;
  const pad = 14;
  const vals = d.flatMap((x) => [x.growth, x.ebitMargin]);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(...vals, 0.01);
  const x = (i: number) => ((i + 0.5) / d.length) * W;
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const path = (f: (k: (typeof d)[number]) => number) => d.map((k, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f(k)).toFixed(1)}`).join(" ");
  let acc = 0;
  return (
    <figure className="glass-inset rounded-xl p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label="เส้นทาง growth และ EBIT margin รายปีตามช่วง">
        {(a.stages ?? []).map((s, k) => {
          const x0 = (acc / d.length) * W;
          acc += Math.max(0, s.years);
          const w = (Math.max(0, s.years) / d.length) * W;
          return (
            <g key={k}>
              <rect x={x0 + 1} y={2} width={Math.max(0, w - 2)} height={H - 4} rx={8} fill={STAGE_COLORS[k]} opacity={0.12} />
              <text x={x0 + 8} y={14} fontSize={10} fill="var(--muted)">
                {s.name || `ช่วง ${k + 1}`} · {s.years}ป
              </text>
            </g>
          );
        })}
        <path d={path((k) => k.growth)} fill="none" stroke="var(--series-1)" strokeWidth={2} />
        <path d={path((k) => k.ebitMargin)} fill="none" stroke="var(--series-3)" strokeWidth={2} strokeDasharray="4 3" />
        {d.map((k, i) => (
          <circle key={i} cx={x(i)} cy={y(k.growth)} r={2.5} fill="var(--series-1)">
            <title>{`ปี ${i + 1}: growth ${fmtPct(k.growth, 1)} · margin ${fmtPct(k.ebitMargin, 1)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="flex gap-4 px-1 text-[11px] text-muted">
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 align-middle" style={{ background: "var(--series-1)" }} />
          Revenue growth
        </span>
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 border-t-2 border-dashed align-middle" style={{ borderColor: "var(--series-3)" }} />
          EBIT margin
        </span>
      </figcaption>
    </figure>
  );
}

function Pct({ value, onChange, placeholder, label }: { value: number | undefined; onChange: (v: number | null) => void; placeholder?: string; label: string }) {
  return (
    <input
      key={value == null ? "empty" : String(value)}
      aria-label={label}
      className="input w-14 py-1 text-right text-xs tabular-nums"
      inputMode="decimal"
      defaultValue={value == null ? "" : String(Number((value * 100).toFixed(4)))}
      placeholder={placeholder?.replace("%", "")}
      onBlur={(e) => {
        const t = e.target.value.trim();
        if (t === "") return onChange(null);
        const n = Number(t);
        if (Number.isFinite(n)) onChange(n / 100);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
