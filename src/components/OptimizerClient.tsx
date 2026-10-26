"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import { recommend, type Objective, type RecommendResult } from "@/lib/finance/recommend";
import type { UniverseAsset } from "@/server/services/optimizer";
import type { AssetClass } from "@/db/schema";
import { applyTargetsAction } from "@/app/(app)/optimizer/actions";
import { BulletChart } from "./charts";
import { NumField, SelectField, Toggle } from "./fields";
import { ASSET_CLASS_LABEL, fmtPct, fmtRatio, fmtThb, signClass } from "@/lib/format";

type ReturnMethod = "historical" | "capm" | "blend";

const OBJECTIVES: { value: Objective; label: string }[] = [
  { value: "max_sharpe", label: "Max Sharpe (tangency)" },
  { value: "min_variance", label: "Minimum variance" },
  { value: "utility", label: "Max utility ตาม risk aversion" },
  { value: "target_return", label: "ผลตอบแทนเป้าหมาย" },
  { value: "target_risk", label: "ความเสี่ยงเป้าหมาย" },
];

export function OptimizerClient({
  assets,
  cov,
  rf,
  erp,
  period,
}: {
  assets: UniverseAsset[];
  cov: number[][];
  rf: number;
  erp: number;
  period: string;
}) {
  const [included, setIncluded] = useState<Set<string>>(new Set(assets.map((a) => a.symbol)));
  const [method, setMethod] = useState<ReturnMethod>("blend");
  const [overrides, setOverrides] = useState<Record<string, number | null>>({});
  const [objective, setObjective] = useState<Objective>("max_sharpe");
  const [riskAversion, setRiskAversion] = useState(4);
  const [targetReturn, setTargetReturn] = useState(0.08);
  const [targetRisk, setTargetRisk] = useState(0.1);
  const [minW, setMinW] = useState(0);
  const [maxW, setMaxW] = useState(0.4);
  const [useRiskFree, setUseRiskFree] = useState(false);
  const [extraCash, setExtraCash] = useState(0);
  const [result, setResult] = useState<{ r: RecommendResult; idx: number[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [applying, startApply] = useTransition();

  const baseReturn = (a: UniverseAsset) => {
    const capm = a.capmReturn ?? a.historicalReturn;
    return method === "historical" ? a.historicalReturn : method === "capm" ? capm : 0.5 * a.historicalReturn + 0.5 * capm;
  };
  const mu = assets.map((a) => overrides[a.symbol] ?? baseReturn(a));

  const params = useMemo(
    () => ({ included, mu: mu.join(), objective, riskAversion, targetReturn, targetRisk, minW, maxW, useRiskFree, extraCash }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [included, method, overrides, objective, riskAversion, targetReturn, targetRisk, minW, maxW, useRiskFree, extraCash],
  );

  function compute() {
    const idx = assets.map((a, i) => (included.has(a.symbol) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) {
      setError("เลือกอย่างน้อย 2 สินทรัพย์");
      return;
    }
    if (minW * idx.length > 1) {
      setError("น้ำหนักขั้นต่ำ × จำนวนสินทรัพย์ ต้องไม่เกิน 100%");
      return;
    }
    setError(null);
    setComputing(true);
    // Let the spinner paint before the (synchronous) optimization runs.
    setTimeout(() => {
      try {
        const cur = idx.map((i) => assets[i].currentValue);
        const r = recommend({
          symbols: idx.map((i) => assets[i].symbol),
          mu: idx.map((i) => mu[i]),
          cov: idx.map((i) => idx.map((j) => cov[i][j])),
          rf,
          bounds: { min: minW, max: maxW },
          objective,
          riskAversion,
          targetReturn,
          targetRisk,
          currentValues: cur,
          totalWealth: cur.reduce((a, b) => a + b, 0) + extraCash,
          useRiskFree,
        });
        setResult({ r, idx });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setComputing(false);
      }
    }, 20);
  }

  // Recompute automatically (debounced) whenever an input changes.
  useEffect(() => {
    const t = setTimeout(compute, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  function applyTargets() {
    if (!result) return;
    const byClass: Partial<Record<AssetClass, number>> = {};
    result.r.allocations.forEach((al, k) => {
      const cls = assets[result.idx[k]].assetClass;
      byClass[cls] = (byClass[cls] ?? 0) + al.weight * 100;
    });
    if (result.r.riskFreeShare > 0) byClass.cash = (byClass.cash ?? 0) + result.r.riskFreeShare * 100;
    startApply(async () => {
      const r = await applyTargetsAction(byClass);
      setApplyMsg(r.ok ? "บันทึกเป็นเป้าหมาย asset allocation แล้ว" : r.error ?? "ผิดพลาด");
    });
  }

  const r = result?.r;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card space-y-3">
          <h2 className="font-semibold">เป้าหมายและข้อจำกัด</h2>
          <SelectField label="Objective" value={objective} options={OBJECTIVES} onChange={setObjective} />
          {(objective === "utility" || useRiskFree) && (
            <label className="block">
              <span className="label">Risk aversion (A) = {riskAversion} — {riskAversion <= 2 ? "รับความเสี่ยงสูง" : riskAversion <= 5 ? "ปานกลาง" : "ระมัดระวัง"}</span>
              <input type="range" min={1} max={10} step={0.5} value={riskAversion} onChange={(e) => setRiskAversion(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
            </label>
          )}
          {objective === "target_return" && <NumField label="ผลตอบแทนเป้าหมายต่อปี" pct value={targetReturn} onChange={(v) => setTargetReturn(v ?? 0)} />}
          {objective === "target_risk" && <NumField label="ความเสี่ยงสูงสุด σ ต่อปี" pct value={targetRisk} onChange={(v) => setTargetRisk(v ?? 0)} />}
          <div className="grid grid-cols-2 gap-3">
            <NumField label="น้ำหนักต่ำสุด/ตัว" pct value={minW} onChange={(v) => setMinW(Math.max(0, v ?? 0))} />
            <NumField label="น้ำหนักสูงสุด/ตัว" pct value={maxW} onChange={(v) => setMaxW(Math.min(1, Math.max(0.01, v ?? 1)))} />
          </div>
          <Toggle label="รวมสินทรัพย์ปลอดความเสี่ยง (Complete portfolio บน CML)" checked={useRiskFree} onChange={setUseRiskFree} />
          <NumField label="เงินลงทุนเพิ่ม (บาท)" value={extraCash} onChange={(v) => setExtraCash(Math.max(0, v ?? 0))} />
          <p className="text-xs text-muted">
            Rf {fmtPct(rf)} · ERP {fmtPct(erp)} · ข้อมูล {period}
          </p>
        </section>

        <section className="card space-y-3 lg:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-semibold">สมมติฐานผลตอบแทนคาดหวัง (แก้ไขได้)</h2>
            <div className="w-56">
              <SelectField
                label="วิธีตั้งต้น"
                value={method}
                options={[
                  { value: "blend", label: "ผสม 50/50 (ลด estimation error)" },
                  { value: "capm", label: "CAPM: Rf + β·ERP" },
                  { value: "historical", label: "ค่าเฉลี่ยในอดีต" },
                ]}
                onChange={setMethod}
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>ใช้</th>
                  <th>สินทรัพย์</th>
                  <th className="num">อดีต</th>
                  <th className="num">β</th>
                  <th className="num">CAPM</th>
                  <th className="num">σ</th>
                  <th className="num w-32">E[R] ที่ใช้ (%)</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a, i) => (
                  <tr key={a.symbol} className={clsx(!included.has(a.symbol) && "opacity-40")}>
                    <td>
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        checked={included.has(a.symbol)}
                        onChange={(e) => {
                          const s = new Set(included);
                          if (e.target.checked) s.add(a.symbol);
                          else s.delete(a.symbol);
                          setIncluded(s);
                        }}
                      />
                    </td>
                    <td>
                      <span className="font-medium">{a.symbol}</span> <span className="text-xs text-muted">{ASSET_CLASS_LABEL[a.assetClass]}</span>
                      {a.held && <span className="ml-1 text-[11px] text-accent">ถืออยู่</span>}
                    </td>
                    <td className="num">{fmtPct(a.historicalReturn, 1)}</td>
                    <td className="num">{fmtRatio(a.beta)}</td>
                    <td className="num">{fmtPct(a.capmReturn, 1)}</td>
                    <td className="num">{fmtPct(a.volatility, 1)}</td>
                    <td className="num">
                      <div className="flex items-center justify-end gap-1">
                        <OverrideInput value={mu[i]} overridden={overrides[a.symbol] != null} onChange={(v) => setOverrides((o) => ({ ...o, [a.symbol]: v }))} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Covariance คำนวณจากผลตอบแทนรายวันเป็นบาทในอดีต · ช่องที่แก้เองมีกรอบเน้น ลบค่าออกเพื่อกลับไปใช้วิธีตั้งต้น</p>
        </section>
      </div>

      {error && <p className="text-sm text-neg">{error}</p>}

      {r && (
        <>
          <section className="card">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Minimum-variance frontier (“รูปหัวกระสุน”)</h2>
              {computing && <span className="text-xs text-muted">กำลังคำนวณ…</span>}
            </div>
            <BulletChart
              unconstrained={r.unconstrained?.curve ?? []}
              constrained={r.bullet}
              assets={result!.idx.map((i) => ({ symbol: assets[i].symbol, volatility: Math.sqrt(cov[i][i]), expectedReturn: mu[i] }))}
              current={r.current}
              recommended={{ volatility: r.final.volatility, expectedReturn: r.final.expectedReturn }}
              gmv={r.gmv}
              tangency={r.tangency}
              rf={rf}
            />
            <p className="mt-1 text-xs text-muted">
              แขนบน = efficient frontier, แขนล่าง (เส้นประ) = พอร์ตที่ไม่มีประสิทธิภาพ · เส้นสีเทา = กรณีขายชอร์ตได้ไม่จำกัด (สูตรปิดของ Markowitz/Merton)
            </p>
          </section>

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="card space-y-1">
              <h2 className="mb-2 font-semibold">พอร์ตที่แนะนำ</h2>
              <KV k="ผลตอบแทนคาดหวัง" v={fmtPct(r.final.expectedReturn)} />
              <KV k="ความเสี่ยง σ" v={fmtPct(r.final.volatility)} />
              <KV k="Sharpe" v={fmtRatio(r.final.sharpe)} />
              {useRiskFree && <KV k="สัดส่วนสินทรัพย์เสี่ยง y*" v={fmtPct(r.riskyShare, 1)} />}
              {r.current && (
                <>
                  <div className="pt-3 text-xs font-semibold text-muted">เทียบพอร์ตปัจจุบัน (เฉพาะสินทรัพย์ที่เลือก)</div>
                  <KV k="E[R] / σ" v={`${fmtPct(r.current.expectedReturn)} / ${fmtPct(r.current.volatility)}`} />
                  <KV k="Sharpe" v={fmtRatio(r.current.sharpe)} />
                </>
              )}
              {r.notes.map((n) => (
                <p key={n} className="pt-2 text-xs text-neg">⚠️ {n}</p>
              ))}
              <div className="pt-3">
                <button className="btn" onClick={applyTargets} disabled={applying}>
                  ใช้เป็นเป้าหมาย asset allocation
                </button>
                {applyMsg && <p className="mt-1 text-xs text-pos">{applyMsg}</p>}
              </div>
            </section>

            <section className="card overflow-x-auto lg:col-span-2">
              <h2 className="mb-3 font-semibold">น้ำหนักที่แนะนำและรายการปรับพอร์ต</h2>
              <table className="table">
                <thead>
                  <tr>
                    <th>สินทรัพย์</th>
                    <th className="num">ปัจจุบัน</th>
                    <th className="num">แนะนำ</th>
                    <th className="num">มูลค่าเป้าหมาย</th>
                    <th className="num">ซื้อ / ขาย</th>
                  </tr>
                </thead>
                <tbody>
                  {r.allocations.map((a) => (
                    <tr key={a.symbol}>
                      <td className="font-medium">{a.symbol}</td>
                      <td className="num">{fmtPct(a.currentWeight, 1)}</td>
                      <td className="num font-medium">
                        <WeightBar w={a.weight} />
                      </td>
                      <td className="num">{fmtThb(a.targetValue)}</td>
                      <td className={clsx("num", signClass(a.trade))}>
                        {Math.abs(a.trade) < 1 ? "–" : `${a.trade > 0 ? "ซื้อ" : "ขาย"} ${fmtThb(Math.abs(a.trade))}`}
                      </td>
                    </tr>
                  ))}
                  {r.riskFreeShare > 0 && (
                    <tr>
                      <td className="font-medium">สินทรัพย์ปลอดความเสี่ยง (เงินฝาก/T-bill)</td>
                      <td />
                      <td className="num font-medium">
                        <WeightBar w={r.riskFreeShare} />
                      </td>
                      <td className="num" colSpan={2} />
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                ⚠️ MPT อ่อนไหวต่อผลตอบแทนคาดหวังมาก ควรใช้ข้อจำกัดน้ำหนัก ทดลองหลายสมมติฐาน และปรับพอร์ตทีละน้อย — เป็นเครื่องมือประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุน
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}

function WeightBar({ w }: { w: number }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-16 rounded-full bg-border/60">
        <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, w * 100)}%`, background: "var(--series-1)" }} />
      </div>
      <span className="w-12 text-right">{fmtPct(w, 1)}</span>
    </div>
  );
}

function OverrideInput({ value, overridden, onChange }: { value: number; overridden: boolean; onChange: (v: number | null) => void }) {
  const [text, setText] = useState((value * 100).toFixed(1));
  useEffect(() => {
    if (!overridden) setText((value * 100).toFixed(1));
  }, [value, overridden]);
  return (
    <input
      className={clsx("input w-20 text-right tabular-nums", overridden && "border-accent")}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === "") return onChange(null);
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n / 100);
      }}
    />
  );
}
