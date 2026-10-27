"use client";

import { useState } from "react";
import clsx from "clsx";
import { NumField } from "./fields";
import { fmtPct, fmtThb, signClass } from "@/lib/format";
import { ExplainButton } from "./ExplainButton";
import { compact } from "@/lib/explain-data";

type Result = {
  name: string;
  pnl: number;
  pnlPct: number;
  navAfter: number;
  byFactor: Record<string, number>;
  positions: { symbol: string; pnl: { total: number }; returnPct: number; assumptions: { beta: number | null; modifiedDuration: number | null } }[];
  correlation: { volatilityBefore: number; volatilityAfter: number; var95Before: number; var95After: number } | null;
  warnings: string[];
};
type Response = {
  nav: number;
  assumptions: Record<string, string>;
  results: Result[];
  history: { worstDay: { date: string | null; return: number }; worst21d: { from: string | null; to: string | null; return: number } | null; coverage: number; note: string } | null;
};

const FACTOR: Record<string, string> = { equity: "หุ้น (β)", rate: "ดอกเบี้ย", fx: "ค่าเงิน", specific: "รายตัว/กลุ่ม", liquidity: "สภาพคล่อง" };

/** Presets or a custom scenario against current holdings (read-only). */
export function StressPanel() {
  const [res, setRes] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [eq, setEq] = useState<number | null>(-0.2);
  const [rate, setRate] = useState<number | null>(0.01);
  const [fx, setFx] = useState<number | null>(-0.1);
  const [corr, setCorr] = useState<number | null>(0.5);
  const [specific, setSpecific] = useState("");

  async function run(custom: boolean) {
    setPending(true);
    setError(null);
    try {
      const spec = Object.fromEntries(
        specific
          .split(",")
          .map((x) => x.split("=").map((y) => y.trim()))
          .filter((p) => p.length === 2 && p[0] && Number.isFinite(Number(p[1])))
          .map(([k, v]) => [k.toUpperCase(), Number(v) / 100]),
      );
      const body = custom
        ? { scenarios: [{ name: "กำหนดเอง", equityShock: eq ?? undefined, rateShock: rate ?? undefined, fxShock: fx ?? undefined, correlationShock: corr ?? undefined, specific: Object.keys(spec).length ? spec : undefined }] }
        : {};
      const r = await fetch("/api/v1/portfolio/stress", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setRes(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-5">
        <NumField label="หุ้นตลาด" pct nullable value={eq} onChange={setEq} />
        <NumField label="ดอกเบี้ย (Δy)" pct nullable value={rate} onChange={setRate} />
        <NumField label="USDTHB" pct nullable value={fx} onChange={setFx} />
        <NumField label="Correlation k" nullable value={corr} onChange={setCorr} />
        <label className="block">
          <span className="label">รายตัว เช่น PTT=-30</span>
          <input className="input" value={specific} onChange={(e) => setSpecific(e.target.value)} placeholder="PTT=-30, AAPL=-10" />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn" disabled={pending} onClick={() => run(true)}>
          {pending ? "กำลังคำนวณ…" : "ทดสอบสถานการณ์นี้"}
        </button>
        <button className="btn-ghost" disabled={pending} onClick={() => run(false)}>
          รันชุดสถานการณ์ตัวอย่าง
        </button>
      </div>
      {error && <p className="text-sm text-neg">{error}</p>}
      {res && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <ExplainButton
              topic="ผล Stress test"
              label="อธิบายผล Stress test"
              data={compact({ NAV: res.nav, สถานการณ์: res.results.map((x) => ({ ชื่อ: x.name, กำไรขาดทุนบาท: x.pnl, ต่อNAV: x.pnlPct, แยกตามปัจจัย: x.byFactor, correlation: x.correlation })), ย้อนหลังจริง: res.history, สมมติฐาน: res.assumptions })}
              hint="Stress test = ถ้าเกิดเหตุการณ์แรง ๆ ตามสมมติ พอร์ตจะขาดทุนเท่าไร แยกว่ามาจากหุ้น ดอกเบี้ย ค่าเงิน หรือเครดิต"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>สถานการณ์</th>
                  <th className="num">กำไร/ขาดทุน</th>
                  <th className="num">%NAV</th>
                  {Object.keys(FACTOR).map((k) => (
                    <th key={k} className="num">{FACTOR[k]}</th>
                  ))}
                  <th className="num">σ ก่อน → หลัง (corr)</th>
                </tr>
              </thead>
              <tbody>
                {res.results.map((r) => (
                  <tr key={r.name}>
                    <td className="font-medium">{r.name}</td>
                    <td className={clsx("num", signClass(r.pnl))}>{fmtThb(r.pnl)}</td>
                    <td className={clsx("num", signClass(r.pnl))}>{fmtPct(r.pnlPct, 1)}</td>
                    {Object.keys(FACTOR).map((k) => (
                      <td key={k} className="num">{r.byFactor[k] ? fmtThb(r.byFactor[k]) : "–"}</td>
                    ))}
                    <td className="num">{r.correlation ? `${fmtPct(r.correlation.volatilityBefore, 1)} → ${fmtPct(r.correlation.volatilityAfter, 1)}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.results.length === 1 && (
            <div className="flex flex-wrap gap-2 text-xs">
              {res.results[0].positions.map((p) => (
                <span key={p.symbol} className="rounded border border-border/60 px-2 py-1">
                  {p.symbol} <span className={signClass(p.pnl.total)}>{fmtPct(p.returnPct, 1)}</span>
                  <span className="text-muted"> (β {p.assumptions.beta?.toFixed(2) ?? "–"}{p.assumptions.modifiedDuration != null ? ` · D ${p.assumptions.modifiedDuration.toFixed(2)}` : ""})</span>
                </span>
              ))}
            </div>
          )}
          {res.history && (
            <p className="text-sm">
              ย้อนหลังด้วยน้ำหนักปัจจุบัน: วันที่แย่ที่สุด {res.history.worstDay.date} <span className="text-neg">{fmtPct(res.history.worstDay.return, 2)}</span>
              {res.history.worst21d && (
                <>
                  {" "}· 21 วันทำการแย่ที่สุด {res.history.worst21d.from} → {res.history.worst21d.to} <span className="text-neg">{fmtPct(res.history.worst21d.return, 1)}</span>
                </>
              )}{" "}
              <span className="text-xs text-muted">(ครอบคลุม {fmtPct(res.history.coverage, 0)} ของ NAV)</span>
            </p>
          )}
          <ul className="list-disc pl-5 text-xs text-muted">
            {Object.values(res.assumptions).map((a) => (
              <li key={a}>{a}</li>
            ))}
            {[...new Set(res.results.flatMap((r) => r.warnings))].map((w) => (
              <li key={w} className="text-neg">{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
