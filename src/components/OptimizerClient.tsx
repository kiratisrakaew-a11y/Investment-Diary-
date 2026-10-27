"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import { recommend, type Objective, type RecommendOutcome } from "@/lib/finance/recommend";
import { blackLitterman, type BlResult, type BlView } from "@/lib/finance/black-litterman";
import type { UniverseAsset } from "@/server/services/optimizer";
import type { AssetClass } from "@/db/schema";
import { applyTargetsAction } from "@/app/(app)/optimizer/actions";
import { BulletChart } from "./charts";
import { RebalancePanel } from "./RebalancePanel";
import { buildConstraints, exposureReport, type ConstraintsInput } from "@/lib/finance/exposure";
import { NumField, SelectField, Toggle } from "./fields";
import { ASSET_CLASS_LABEL, fmtPct, fmtRatio, fmtThb, signClass } from "@/lib/format";
import { CardTitle } from "./ExplainButton";
import { compact } from "@/lib/explain-data";

type ReturnMethod = "historical" | "capm" | "blend" | "black_litterman";

const OBJECTIVES: { value: Objective; label: string }[] = [
  { value: "max_sharpe", label: "Max Sharpe (tangency)" },
  { value: "min_variance", label: "Minimum variance" },
  { value: "utility", label: "Max utility ตาม risk aversion" },
  { value: "target_return", label: "ผลตอบแทนเป้าหมาย" },
  { value: "target_risk", label: "ความเสี่ยงเป้าหมาย" },
];

export function OptimizerClient({
  assets,
  cov: covSample,
  covShrunk,
  shrinkage,
  periodsPerYear,
  rf,
  erp,
  period,
}: {
  assets: UniverseAsset[];
  cov: number[][];
  covShrunk: number[][];
  shrinkage: number;
  periodsPerYear: number;
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
  const [covMethod, setCovMethod] = useState<"sample" | "ledoit_wolf">("sample");
  const [maxIssuer, setMaxIssuer] = useState<number | null>(null);
  const [maxSector, setMaxSector] = useState<number | null>(null);
  const [maxDuration, setMaxDuration] = useState<number | null>(null);
  const cov = covMethod === "ledoit_wolf" ? covShrunk : covSample;
  // Black–Litterman: market weights are entered by the user (never defaulted to holdings).
  const [mktW, setMktW] = useState<Record<string, number | null>>({});
  const [delta, setDelta] = useState<number | null>(null);
  const [tau, setTau] = useState(0.05);
  const [views, setViews] = useState<BlView[]>([]);
  const [postCov, setPostCov] = useState(false);
  const [result, setResult] = useState<{
    r: RecommendOutcome;
    idx: number[];
    prior: RecommendOutcome | null;
    bl: BlResult | null;
    built?: ReturnType<typeof buildConstraints>;
    exposure?: ReturnType<typeof exposureReport> | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [applying, startApply] = useTransition();

  const isBl = method === "black_litterman";
  const idxIncluded = assets.map((a, i) => (included.has(a.symbol) ? i : -1)).filter((i) => i >= 0);
  const bl = useMemo(() => {
    if (!isBl || idxIncluded.length < 2) return null;
    return blackLitterman({
      symbols: idxIncluded.map((i) => assets[i].symbol),
      cov: idxIncluded.map((i) => idxIncluded.map((j) => cov[i][j])),
      rf,
      marketWeights: Object.fromEntries(Object.entries(mktW).filter((e): e is [string, number] => e[1] != null)),
      riskAversion: delta ?? undefined,
      marketPremium: erp,
      tau,
      views,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBl, included, cov, rf, erp, mktW, delta, tau, views]);
  const blPos = new Map(idxIncluded.map((i, k) => [i, k]));

  const baseReturn = (a: UniverseAsset, i: number) => {
    const capm = a.capmReturn ?? a.historicalReturn;
    if (isBl) return bl?.ok && blPos.has(i) ? bl.posterior[blPos.get(i)!] : capm;
    return method === "historical" ? a.historicalReturn : method === "capm" ? capm : 0.5 * a.historicalReturn + 0.5 * capm;
  };
  const mu = assets.map((a, i) => overrides[a.symbol] ?? baseReturn(a, i));

  const params = useMemo(
    () => ({ included, mu: mu.join(), objective, riskAversion, targetReturn, targetRisk, minW, maxW, useRiskFree, extraCash, covMethod, bl, postCov, maxIssuer, maxSector, maxDuration }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [included, method, overrides, objective, riskAversion, targetReturn, targetRisk, minW, maxW, useRiskFree, extraCash, covMethod, bl, postCov, maxIssuer, maxSector, maxDuration],
  );

  function compute() {
    const idx = assets.map((a, i) => (included.has(a.symbol) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 2) {
      setError("เลือกอย่างน้อย 2 สินทรัพย์");
      return;
    }
    if (isBl && !bl?.ok) {
      setError(bl ? `Black–Litterman: ${bl.errors.join(" · ")}` : "Black–Litterman ต้องเลือกอย่างน้อย 2 สินทรัพย์");
      setResult(null);
      return;
    }
    setError(null);
    setComputing(true);
    // Let the spinner paint before the (synchronous) optimization runs.
    setTimeout(() => {
      try {
        const cur = idx.map((i) => assets[i].currentValue);
        const subCov = idx.map((i) => idx.map((j) => cov[i][j]));
        const spec: ConstraintsInput = {
          ...(maxIssuer != null ? { maxPerIssuer: maxIssuer } : {}),
          ...(maxSector != null ? { maxPerSector: maxSector } : {}),
          ...(maxDuration != null ? { maxDuration } : {}),
        };
        const wealth = cur.reduce((a, b) => a + b, 0) + extraCash;
        // Same constraint builder as the server optimizer (issuer / sector / duration → linear rows).
        const built = buildConstraints(idx.map((i) => assets[i]), { min: minW, max: maxW }, Object.keys(spec).length ? spec : undefined, wealth);
        const common = {
          symbols: idx.map((i) => assets[i].symbol),
          rf,
          bounds: built.bounds,
          objective,
          riskAversion,
          targetReturn,
          targetRisk,
          currentValues: cur,
          totalWealth: cur.reduce((a, b) => a + b, 0) + extraCash,
          useRiskFree,
        };
        const r = recommend({ ...common, mu: idx.map((i) => mu[i]), cov: isBl && postCov && bl?.posteriorCov ? bl.posteriorCov : subCov });
        // Same optimizer and constraints with the equilibrium prior, for the weight comparison.
        const prior = isBl && bl?.ok ? recommend({ ...common, mu: bl.prior, cov: subCov }) : null;
        const exposure = r.ok ? exposureReport(idx.map((i) => assets[i]), r.risky.weights, built.durations, wealth * r.riskyShare) : null;
        setResult({ r, idx, prior, bl: isBl ? bl : null, built, exposure });
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
    if (!result || !result.r.ok) return;
    const ok = result.r;
    const byClass: Partial<Record<AssetClass, number>> = {};
    ok.allocations.forEach((al, k) => {
      const cls = assets[result.idx[k]].assetClass;
      byClass[cls] = (byClass[cls] ?? 0) + al.weight * 100;
    });
    if (ok.riskFreeShare > 0) byClass.cash = (byClass.cash ?? 0) + ok.riskFreeShare * 100;
    startApply(async () => {
      const r = await applyTargetsAction(byClass);
      setApplyMsg(r.ok ? "บันทึกเป็นเป้าหมาย asset allocation แล้ว" : r.error ?? "ผิดพลาด");
    });
  }

  const outcome = result?.r;
  const r = outcome?.ok ? outcome : null;
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
          {useRiskFree && <p className="text-xs text-muted">ส่วนเสี่ยง = tangency portfolio; objective กำหนดสัดส่วนบนเส้น CAL (ไม่กู้ยืม — สูงสุด 100%)</p>}
          <SelectField
            label="Covariance"
            value={covMethod}
            options={[
              { value: "sample", label: "Sample (ข้อมูลในอดีตตรง ๆ)" },
              { value: "ledoit_wolf", label: `Ledoit–Wolf shrinkage (δ = ${(shrinkage * 100).toFixed(1)}%)` },
            ]}
            onChange={setCovMethod}
          />
          <NumField label="เงินลงทุนเพิ่ม (บาท)" value={extraCash} onChange={(v) => setExtraCash(Math.max(0, v ?? 0))} />
          <div className="grid grid-cols-3 gap-2">
            <NumField label="สูงสุด/ผู้ออก" pct nullable value={maxIssuer} onChange={setMaxIssuer} hint="รวมหุ้นและหุ้นกู้ของผู้ออกเดียวกัน (ตั้งผู้ออกที่หน้าพันธบัตร / update_asset_profile)" />
            <NumField label="สูงสุด/หมวด" pct nullable value={maxSector} onChange={setMaxSector} hint="ใช้หมวดที่ผู้ใช้ระบุพร้อมแหล่งที่มา — ตัวที่ไม่ระบุไม่ถูกจัดเข้าหมวด" />
            <NumField label="Duration สูงสุด (ปี)" nullable value={maxDuration} onChange={setMaxDuration} hint="Modified duration ของพอร์ตเสี่ยง (พันธบัตรจากราคาล่าสุด อื่น ๆ = 0)" />
          </div>
          <p className="text-xs text-muted">
            Rf {fmtPct(rf)} · ERP {fmtPct(erp)} · ข้อมูล {period} · {periodsPerYear.toFixed(1)} งวด/ปี · long-only, ลงทุนครบ 100%, ไม่มี margin
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
                  { value: "blend", label: "ผสม 50/50 (heuristic)" },
                  { value: "capm", label: "CAPM: Rf + β·ERP" },
                  { value: "historical", label: "ค่าเฉลี่ยในอดีต" },
                  { value: "black_litterman", label: "Black–Litterman (ดุลยภาพ + views)" },
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
                  {isBl && <th className="num w-28">น้ำหนักตลาด (%)</th>}
                  {isBl && <th className="num">Prior Π</th>}
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
                    {isBl && (
                      <td className="num">
                        <PctInput value={mktW[a.symbol] ?? null} onChange={(v) => setMktW((m) => ({ ...m, [a.symbol]: v }))} />
                      </td>
                    )}
                    {isBl && <td className="num">{bl?.ok && blPos.has(i) ? fmtPct(bl.prior[blPos.get(i)!], 1) : "–"}</td>}
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
          <p className="text-xs text-muted">
            {isBl && "Black–Litterman: E[R] ที่ใช้ = posterior · "}อดีต = ค่าเฉลี่ยเลขคณิต × จำนวนงวดต่อปี (เฉพาะวันที่ทุกสินทรัพย์มีราคา, เป็นบาท) · ผสม 50/50 เป็นวิธีประมาณแบบง่าย ไม่ได้แก้ estimation error · ช่องที่แก้เองมีกรอบเน้น ลบค่าออกเพื่อกลับไปใช้วิธีตั้งต้น
          </p>
        </section>
      </div>

      {isBl && (
        <BlPanel
          symbols={idxIncluded.map((i) => assets[i].symbol)}
          bl={bl}
          delta={delta}
          setDelta={setDelta}
          tau={tau}
          setTau={setTau}
          views={views}
          setViews={setViews}
          postCov={postCov}
          setPostCov={setPostCov}
          setEqual={() => setMktW(Object.fromEntries(idxIncluded.map((i) => [assets[i].symbol, 1 / idxIncluded.length])))}
          erp={erp}
        />
      )}

      {error && <p className="text-sm text-neg">{error}</p>}
      {outcome && !outcome.ok && (
        <section className="card border-l-4 border-l-neg">
          <h2 className="font-semibold text-neg">คำนวณน้ำหนักไม่ได้ภายใต้ข้อจำกัดนี้</h2>
          <p className="mt-1 text-sm">{outcome.issue.message}</p>
          {outcome.issue.suggestion && <p className="mt-1 text-sm text-muted">แนะนำ: {outcome.issue.suggestion}</p>}
          <p className="mt-2 text-xs text-muted">ระบบไม่ผ่อนข้อจำกัดให้เอง เพื่อไม่ให้ได้น้ำหนักที่ขัดกับที่คุณตั้งไว้ ({outcome.issue.code})</p>
        </section>
      )}

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
              แขนบน = efficient frontier, แขนล่าง (เส้นประ) = พอร์ตที่ไม่มีประสิทธิภาพ · เส้นสีน้ำเงิน = ตามข้อจำกัดน้ำหนัก {fmtPct(minW, 0)}–{fmtPct(maxW, 0)} (ลงทุนได้จริง) · เส้นสีเทา = สูตรปิดแบบขายชอร์ตได้ไม่จำกัด ใช้เทียบทฤษฎีเท่านั้น (มีน้ำหนักติดลบ ลงทุนจริงไม่ได้)
            </p>
          </section>

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="card space-y-1">
              <CardTitle
                title="พอร์ตที่แนะนำ"
                className="mb-2"
                explain={{
                  data: compact({ เป้าหมาย: r.objective, ผลตอบแทนคาดหวังต่อปี: r.final.expectedReturn, ความเสี่ยงต่อปี: r.final.volatility, Sharpe: r.final.sharpe, สัดส่วนสินทรัพย์เสี่ยง: r.riskyShare, สัดส่วนสินทรัพย์ไร้ความเสี่ยง: r.riskFreeShare, พอร์ตปัจจุบัน: r.current ? { expectedReturn: r.current.expectedReturn, volatility: r.current.volatility, sharpe: r.current.sharpe } : null, คำเตือน: r.warnings }),
                  hint: "ผลตอบแทนคาดหวังและความเสี่ยงประมาณจากข้อมูลในอดีต/สมมติฐานที่ผู้ใช้ตั้ง ไม่ใช่การรับประกัน",
                }}
              />
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
              {result?.built?.warnings.map((n) => (
                <p key={n} className="pt-2 text-xs text-muted">ℹ️ {n}</p>
              ))}
              {result?.exposure && (
                <div className="pt-3 text-xs">
                  <div className="font-semibold text-muted">การกระจุกตัวของพอร์ตที่แนะนำ</div>
                  <div>ผู้ออก: {result.exposure.byIssuer.map((g) => `${g.key} ${fmtPct(g.weight, 1)}`).join(" · ")}</div>
                  <div>หมวด: {result.exposure.bySector.map((g) => `${g.key} ${fmtPct(g.weight, 1)}`).join(" · ")}</div>
                  <div>Duration พอร์ต {result.exposure.duration.toFixed(2)} ปี{result.exposure.dv01Thb != null ? ` · DV01 ≈ ${fmtThb(result.exposure.dv01Thb)} ต่อ 1bp` : ""}</div>
                </div>
              )}
              {r.warnings.map((n) => (
                <p key={n} className="pt-2 text-xs text-neg">⚠️ {n}</p>
              ))}
              <div className="pt-3">
                <button className="btn" onClick={applyTargets} disabled={applying || !r}>
                  ใช้เป็นเป้าหมาย asset allocation
                </button>
                {applyMsg && <p className="mt-1 text-xs text-pos">{applyMsg}</p>}
              </div>
            </section>

            <section className="card overflow-x-auto lg:col-span-2">
              <CardTitle
                title="น้ำหนักที่แนะนำและรายการปรับพอร์ต"
                explain={{ data: compact({ รายการ: r.allocations, exposure: result?.exposure ?? null }), hint: "weight = น้ำหนักแนะนำ, currentWeight = ปัจจุบัน, trade = จำนวนเงิน (บาท) ที่ต้องซื้อ(+)/ขาย(−)" }}
              />
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
              <div className="mt-3 grid grid-cols-2 gap-x-6 text-xs sm:grid-cols-3">
                <KV k="Solver" v={`${r.solver.status === "optimal" ? "optimal" : r.solver.status} · ${r.solver.iterations} รอบ`} />
                <KV k="KKT residual" v={r.solver.kktResidual.toExponential(1)} />
                <KV k="|Σw − 1|" v={r.solver.sumError.toExponential(1)} />
                <KV k="เกินขอบเขตสูงสุด" v={r.solver.maxBoundViolation.toExponential(1)} />
                <KV k="ข้อจำกัด" v={`${r.constraints.n} ตัว · ${fmtPct(r.constraints.min, 0)}–${fmtPct(r.constraints.max, 0)}`} />
                <KV k="Condition number Σ" v={Number.isFinite(r.covariance.conditionNumber) ? r.covariance.conditionNumber.toExponential(1) : "∞ (singular)"} />
              </div>
              {result?.bl?.ok && (
                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-semibold">เทียบน้ำหนัก: ตลาด · prior (ดุลยภาพ) · posterior (แนะนำ)</h3>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>สินทรัพย์</th>
                        <th className="num">ตลาด</th>
                        <th className="num">จาก prior</th>
                        <th className="num">จาก posterior</th>
                        <th className="num">Prior E[R]</th>
                        <th className="num">Posterior E[R]</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.idx.map((i, k) => (
                        <tr key={assets[i].symbol}>
                          <td className="font-medium">{assets[i].symbol}</td>
                          <td className="num">{fmtPct(result.bl!.marketWeights[k], 1)}</td>
                          <td className="num">{result.prior?.ok ? fmtPct(result.prior.risky.weights[k] * result.prior.riskyShare, 1) : "–"}</td>
                          <td className="num font-medium">{fmtPct(r.allocations[k].weight, 1)}</td>
                          <td className="num">{fmtPct(result.bl!.prior[k], 2)}</td>
                          <td className={clsx("num", signClass(result.bl!.posterior[k] - result.bl!.prior[k]))}>{fmtPct(result.bl!.posterior[k], 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-xs text-muted">
                ⚠️ MPT อ่อนไหวต่อผลตอบแทนคาดหวังมาก ควรใช้ข้อจำกัดน้ำหนัก ทดลองหลายสมมติฐาน และปรับพอร์ตทีละน้อย — เป็นเครื่องมือประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุน
              </p>
            </section>
          </div>
          <RebalancePanel suggested={r.allocations.map((a) => ({ symbol: a.symbol, weight: a.weight }))} extraCash={extraCash} />
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

function PctInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value == null ? "" : String(+(value * 100).toFixed(4)));
  useEffect(() => {
    const n = Number(text);
    if (value == null ? text !== "" : !Number.isFinite(n) || Math.abs(n / 100 - value) > 1e-9) setText(value == null ? "" : String(+(value * 100).toFixed(4)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="input w-20 text-right tabular-nums"
      inputMode="decimal"
      value={text}
      placeholder="–"
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === "") return onChange(null);
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n / 100);
      }}
    />
  );
}

function BlPanel({
  symbols,
  bl,
  delta,
  setDelta,
  tau,
  setTau,
  views,
  setViews,
  postCov,
  setPostCov,
  setEqual,
  erp,
}: {
  symbols: string[];
  bl: BlResult | null;
  delta: number | null;
  setDelta: (v: number | null) => void;
  tau: number;
  setTau: (v: number) => void;
  views: BlView[];
  setViews: (v: BlView[]) => void;
  postCov: boolean;
  setPostCov: (v: boolean) => void;
  setEqual: () => void;
  erp: number;
}) {
  const upd = (k: number, v: Partial<BlView>) => setViews(views.map((x, i) => (i === k ? ({ ...x, ...v } as BlView) : x)));
  const first = symbols[0] ?? "";
  const second = symbols[1] ?? "";
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-semibold">Black–Litterman</h2>
        <button type="button" className="btn-ghost text-xs" onClick={setEqual}>
          ตั้งน้ำหนักตลาดเท่ากันทุกตัว
        </button>
      </div>
      <p className="text-xs text-muted">
        Prior Π = δΣw<sub>ตลาด</sub> (ผลตอบแทนส่วนเกินดุลยภาพ) · ใส่น้ำหนักตลาดเอง เช่น ตามมูลค่าตลาดหรือน้ำหนักในดัชนี — ระบบไม่ใช้พอร์ตที่คุณถือแทนให้ ·
        Ω ของแต่ละ view = ((1 − ความมั่นใจ) ÷ ความมั่นใจ) × pτΣpᵀ (50% = He–Litterman, 100% = view เป็นจริงแน่นอน)
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <NumField label="Market risk aversion δ" nullable value={delta} onChange={setDelta} hint={`ว่าง = คำนวณจาก ERP ${fmtPct(erp)} ÷ σ² ตลาด`} />
        <NumField label="τ" value={tau} onChange={(v) => setTau(v ?? 0.05)} hint="ความไม่แน่นอนของ prior (มักใช้ 0.025–0.05)" />
        <div className="flex items-end sm:col-span-2">
          <Toggle label="ใช้ posterior covariance (Σ + M)" checked={postCov} onChange={setPostCov} />
        </div>
      </div>
      {bl?.ok && <p className="text-xs text-muted">δ = {bl.riskAversion?.toFixed(2)} ({bl.riskAversionSource === "given" ? "กำหนดเอง" : "คำนวณจาก ERP"}) · τ = {bl.tau}</p>}

      <div className="space-y-2">
        {views.map((v, k) => (
          <div key={k} className="flex flex-wrap items-end gap-2 rounded border border-border/60 p-2 text-sm">
            <div className="w-36">
              <SelectField
                label={`View ${k + 1}`}
                value={v.type}
                options={[
                  { value: "absolute", label: "ผลตอบแทนของตัวเดียว" },
                  { value: "relative", label: "ตัวหนึ่งชนะอีกตัว" },
                ]}
                onChange={(t) =>
                  upd(k, t === "absolute" ? ({ type: "absolute", symbol: first, long: undefined, short: undefined } as never) : ({ type: "relative", long: [first], short: [second], symbol: undefined } as never))
                }
              />
            </div>
            {v.type === "absolute" ? (
              <label className="block">
                <span className="label">สินทรัพย์</span>
                <select className="input" value={v.symbol} onChange={(e) => upd(k, { symbol: e.target.value })}>
                  {symbols.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="block">
                  <span className="label">ชนะ (long)</span>
                  <input className="input w-36" value={v.long.join(",")} onChange={(e) => upd(k, { long: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })} />
                </label>
                <label className="block">
                  <span className="label">แพ้ (short)</span>
                  <input className="input w-36" value={v.short.join(",")} onChange={(e) => upd(k, { short: e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) })} />
                </label>
              </>
            )}
            <div className="w-32">
              <NumField label={v.type === "absolute" ? "ผลตอบแทน/ปี" : "ชนะกัน/ปี"} pct value={v.return} onChange={(x) => upd(k, { return: x ?? 0 })} />
            </div>
            <div className="w-28">
              <NumField label="ความมั่นใจ" pct value={v.confidence} onChange={(x) => upd(k, { confidence: x ?? 0.5 })} />
            </div>
            <button type="button" className="btn-ghost text-xs" onClick={() => setViews(views.filter((_, i) => i !== k))}>
              ลบ
            </button>
            {bl?.ok && bl.views[k] && (
              <span className="text-xs text-muted">
                ดุลยภาพ {fmtPct(bl.views[k].priorValue, 2)} → view {fmtPct(bl.views[k].q, 2)} → posterior {fmtPct(bl.views[k].posteriorValue, 2)}
              </span>
            )}
          </div>
        ))}
        <button type="button" className="btn-ghost text-xs" onClick={() => setViews([...views, { type: "absolute", symbol: first, return: 0.08, confidence: 0.5 }])}>
          + เพิ่ม view
        </button>
      </div>
      {bl && !bl.ok && bl.errors.map((e) => <p key={e} className="text-sm text-neg">{e}</p>)}
      {bl?.ok && bl.warnings.map((w) => <p key={w} className="text-xs text-muted">ℹ️ {w}</p>)}
    </section>
  );
}
