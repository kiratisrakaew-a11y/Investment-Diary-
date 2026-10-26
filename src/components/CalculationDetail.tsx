"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { explanationToText, formatValue, type Explanation } from "@/lib/valuation-explain";
import { fmtNum, fmtPct, signClass } from "@/lib/format";

/** Full step-by-step calculation of one valuation: assumptions, formulas with numbers, forecast table, warnings. */
export function CalculationDetail({ e, compact }: { e: Explanation; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const groups = [...new Set(e.assumptions.map((a) => a.group))];
  return (
    <div className="calc-detail space-y-5 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {!compact && <div className="text-xs text-muted">{e.title}</div>}
          <div className="text-2xl font-semibold tabular-nums">{fmtNum(e.value)}</div>
          <div className={clsx("text-sm", signClass(e.upside))}>
            {e.upside != null && `${e.upside >= 0 ? "Upside" : "Downside"} ${fmtPct(Math.abs(e.upside), 1)} จากราคา ${fmtNum(e.price)}`}
          </div>
        </div>
        <div className="flex gap-2 print:hidden">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={async () => {
              await navigator.clipboard.writeText(explanationToText(e));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "คัดลอกแล้ว" : "คัดลอกเป็นข้อความ"}
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => window.print()}>
            พิมพ์
          </button>
        </div>
      </div>

      {e.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-neg/40 bg-neg/5 p-3 text-xs text-neg">
          {e.warnings.map((w) => (
            <li key={w}>⚠️ {w}</li>
          ))}
        </ul>
      )}

      <section>
        <h3 className="mb-2 font-semibold">1. สมมติฐานที่ใช้</h3>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <div className="mb-1 text-xs font-semibold text-muted">{g}</div>
              {e.assumptions
                .filter((a) => a.group === g)
                .map((a) => (
                  <div key={a.label} className="flex justify-between gap-3 border-b border-border/60 py-1">
                    <span className="text-muted">
                      {a.label}
                      {a.note && <span className="block text-[11px]">{a.note}</span>}
                    </span>
                    <span className="text-right tabular-nums">{formatValue(a.value, a.unit)}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 font-semibold">2. ขั้นตอนการคำนวณ</h3>
        <ol className="space-y-2">
          {e.steps.map((s, i) => (
            <li key={i} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {i + 1}. {s.label}
                </span>
                <span className="font-semibold tabular-nums">{formatValue(s.result, s.unit)}</span>
              </div>
              <div className="mt-1 font-mono text-xs text-accent">{s.formula}</div>
              <div className="mt-0.5 font-mono text-xs break-words text-muted">
                = {s.substitution} = {formatValue(s.result, s.unit)}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {e.table && (
        <section className="overflow-x-auto">
          <h3 className="mb-2 font-semibold">3. ตารางประมาณการ</h3>
          <table className="table">
            <thead>
              <tr>
                <th />
                {e.table.columns.map((c) => (
                  <th key={c} className="num">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {e.table.rows.map((r) => (
                <tr key={r.label} className={r.strong ? "font-semibold" : ""}>
                  <td>{r.label}</td>
                  {r.values.map((v, i) => (
                    <td key={i} className="num">{formatValue(v, r.unit)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/** Right-side drawer (full-screen sheet on mobile) holding a CalculationDetail. */
export function CalculationDrawer({ e, onClose }: { e: Explanation | null; onClose: () => void }) {
  useEffect(() => {
    if (!e) return;
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [e, onClose]);
  if (!e) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end print:static print:block" role="dialog" aria-modal="true" aria-label={e.title}>
      <button type="button" aria-label="ปิด" className="absolute inset-0 bg-black/40 print:hidden" onClick={onClose} />
      <div className="relative h-full w-full overflow-y-auto bg-panel p-5 shadow-xl sm:max-w-2xl print:max-w-none print:shadow-none">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">วิธีคำนวณ: {e.title}</h2>
          <button type="button" className="btn-ghost text-xs print:hidden" onClick={onClose}>
            ✕ ปิด
          </button>
        </div>
        <CalculationDetail e={e} compact />
      </div>
    </div>
  );
}
