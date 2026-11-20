"use client";

/**
 * Portfolio model comparison: one set of assets, six models, the same estimator, bounds and costs.
 * Shows each model's weights, the ex-ante estimate, the in-sample fit and the out-of-sample result
 * (train / test split or walk-forward).
 */
import { useMemo, useState } from "react";
import clsx from "clsx";
import { ModelLinesChart } from "./charts";
import { NumField, SelectField, Toggle } from "./fields";
import { CardTitle } from "./ExplainButton";
import { compact } from "@/lib/explain-data";
import { ASSET_CLASS_LABEL, fmtPct, fmtRatio, fmtThb } from "@/lib/format";
import {
  COMPARISON_MODELS,
  MODEL_LABEL,
  type ComparisonModel,
  type ModelComparisonResult,
  type RealisedStats,
} from "@/lib/finance/model-comparison";
import type { AssetClass } from "@/db/schema";

type Asset = { symbol: string; assetClass: AssetClass };
type Response = ModelComparisonResult & {
  period: { from: string; to: string };
  excluded: { symbol: string; reason: string }[];
  limitations: string[];
  riskFreeRate: number;
  benchmark: { symbol: string } | null;
  input: { rebalanceEveryObservations: number; observations: number };
};
type Mode = "split" | "walkForward";

const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
];
const colorOf = (m: ComparisonModel) =>
  SERIES[COMPARISON_MODELS.indexOf(m) % SERIES.length];

function ModelName({ model }: { model: ComparisonModel }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: colorOf(model) }}
        aria-hidden
      />
      {MODEL_LABEL[model]}
    </span>
  );
}

/** Index of the best finite value (max or min); −1 when fewer than two are comparable. */
function bestIndex(
  values: (number | null | undefined)[],
  better: "high" | "low",
) {
  const ok = values
    .map((v, i) => [v, i] as const)
    .filter(
      (e): e is readonly [number, number] =>
        e[0] != null && Number.isFinite(e[0]),
    );
  if (ok.length < 2) return -1;
  return ok.reduce((b, e) =>
    (better === "high" ? e[0] > b[0] : e[0] < b[0]) ? e : b,
  )[1];
}

export function ModelComparisonClient({ assets }: { assets: Asset[] }) {
  const [included, setIncluded] = useState<Set<string>>(
    new Set(assets.map((a) => a.symbol)),
  );
  const [splitPct, setSplitPct] = useState(70);
  const [windowDays, setWindowDays] = useState(252);
  const [rebalance, setRebalance] = useState<
    "monthly" | "quarterly" | "semiannual" | "annual"
  >("quarterly");
  const [returnMethod, setReturnMethod] = useState<
    "historical" | "capm" | "blend"
  >("blend");
  const [covMethod, setCovMethod] = useState<"sample" | "ledoit_wolf">(
    "ledoit_wolf",
  );
  const [minW, setMinW] = useState(0);
  const [maxW, setMaxW] = useState(1);
  const [useCosts, setUseCosts] = useState(true);
  const [mode, setMode] = useState<Mode>("split");
  const [res, setRes] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // n assets cannot each stay under the cap unless n × max ≥ 100%.
  const infeasible = included.size * maxW < 1 - 1e-9;

  async function run() {
    setPending(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/portfolio/compare-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbols: [...included],
          splitPct,
          windowDays,
          rebalance,
          returnMethod,
          covMethod,
          minWeight: minW,
          maxWeight: maxW,
          useCosts,
        }),
      });
      const data = await r.json();
      if (!r.ok)
        throw new Error(
          data.error ??
            data.issues
              ?.map((i: { message: string }) => i.message)
              .join(", ") ??
            `HTTP ${r.status}`,
        );
      setRes(data);
      if (!data.split && data.walkForward) setMode("walkForward");
      if (!data.walkForward && data.split) setMode("split");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRes(null);
    } finally {
      setPending(false);
    }
  }

  const view = res ? (mode === "split" ? res.split : res.walkForward) : null;
  const weightRows = useMemo(() => {
    if (!res || !view) return [];
    return view.results.map((m) => ({
      model: m.model,
      ok: m.ok,
      w: "weights" in m ? m.weights : m.latestWeights,
    }));
  }, [res, view]);
  const okModels =
    view?.results
      .filter((m) => m.ok)
      .map((m) => ({ key: m.model, name: MODEL_LABEL[m.model] })) ?? [];
  const oos = (view?.results ?? []).map((m) => m.outOfSample);
  const best = {
    ret: bestIndex(
      oos.map((o) => o?.annualReturn),
      "high",
    ),
    vol: bestIndex(
      oos.map((o) => o?.volatility),
      "low",
    ),
    sharpe: bestIndex(
      oos.map((o) => o?.sharpe),
      "high",
    ),
    mdd: bestIndex(
      oos.map((o) => o?.maxDrawdown),
      "low",
    ),
  };
  const hi = (on: boolean) => clsx("num", on && "font-semibold text-pos");
  const ret = (o: RealisedStats | null) =>
    o
      ? `${fmtPct(o.annualReturn, 1)}${o.annualised === "extrapolated" ? "*" : ""}`
      : "–";
  const anyExtrapolated = (view?.results ?? []).some(
    (m) =>
      m.outOfSample?.annualised === "extrapolated" ||
      ("inSample" in m && m.inSample?.annualised === "extrapolated"),
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card space-y-3">
          <h2 className="text-[15px] font-semibold">เงื่อนไขการเปรียบเทียบ</h2>
          <div className="grid grid-cols-2 gap-3">
            <NumField
              label="ช่วงฝึก (% ของข้อมูล)"
              value={splitPct}
              onChange={(v) =>
                setSplitPct(Math.min(90, Math.max(50, Math.round(v ?? 70))))
              }
              hint="แบ่งช่วง: ส่วนแรกใช้หาน้ำหนัก ส่วนที่เหลือคือ Out-of-Sample"
            />
            <NumField
              label="ช่วงฝึก Walk-forward (วัน)"
              value={windowDays}
              onChange={(v) =>
                setWindowDays(Math.max(30, Math.round(v ?? 252)))
              }
              hint="จำนวนวันที่มีราคาที่ใช้ประมาณใหม่ทุกรอบ"
            />
            <SelectField
              label="ปรับพอร์ต"
              value={rebalance}
              options={[
                { value: "monthly", label: "ทุกเดือน" },
                { value: "quarterly", label: "ทุกไตรมาส" },
                { value: "semiannual", label: "ทุกครึ่งปี" },
                { value: "annual", label: "ทุกปี" },
              ]}
              onChange={setRebalance}
            />
            <SelectField
              label="ผลตอบแทนคาดหวัง (μ)"
              value={returnMethod}
              options={[
                { value: "historical", label: "ค่าเฉลี่ยในช่วงฝึก" },
                { value: "capm", label: "CAPM (β ในช่วงฝึก)" },
                { value: "blend", label: "ผสม 50/50" },
              ]}
              onChange={setReturnMethod}
            />
            <SelectField
              label="Covariance"
              value={covMethod}
              options={[
                { value: "ledoit_wolf", label: "Ledoit–Wolf" },
                { value: "sample", label: "Sample" },
              ]}
              onChange={setCovMethod}
            />
            <div />
            <NumField
              label="น้ำหนักต่ำสุด/ตัว"
              pct
              value={minW}
              onChange={(v) => setMinW(Math.max(0, v ?? 0))}
            />
            <NumField
              label="น้ำหนักสูงสุด/ตัว"
              pct
              value={maxW}
              onChange={(v) => setMaxW(Math.min(1, Math.max(0.01, v ?? 1)))}
            />
          </div>
          <Toggle
            label="หักต้นทุนการซื้อขายในช่วงทดสอบ (จากหน้าตั้งค่า)"
            checked={useCosts}
            onChange={setUseCosts}
          />
          {infeasible && (
            <p className="text-xs text-warn">
              น้ำหนักสูงสุด {fmtPct(maxW, 0)} × {included.size} ตัว ไม่ถึง 100%
              — โมเดลที่ใช้ optimizer จะหาคำตอบไม่ได้
            </p>
          )}
          <button
            className="btn"
            onClick={run}
            disabled={pending || included.size < 2}
          >
            {pending ? "กำลังเปรียบเทียบ…" : "เปรียบเทียบ 6 โมเดล"}
          </button>
          {included.size < 2 && (
            <p className="text-xs text-muted">เลือกอย่างน้อย 2 สินทรัพย์</p>
          )}
        </section>

        <section className="card lg:col-span-2">
          <h2 className="mb-1 text-[15px] font-semibold">
            ชุดสินทรัพย์{" "}
            <span className="text-xs font-normal text-muted">
              — ทุกโมเดลใช้ชุดเดียวกัน ({included.size} ตัว)
            </span>
          </h2>
          <div className="flex flex-wrap gap-2">
            {assets.map((a) => {
              const on = included.has(a.symbol);
              return (
                <button
                  key={a.symbol}
                  type="button"
                  aria-pressed={on}
                  title={ASSET_CLASS_LABEL[a.assetClass]}
                  className={clsx(
                    "rounded-full border px-3 py-1 text-xs",
                    on
                      ? "border-accent/60 bg-panel-2 font-medium text-text"
                      : "border-border text-muted",
                  )}
                  onClick={() => {
                    const s = new Set(included);
                    if (on) s.delete(a.symbol);
                    else s.add(a.symbol);
                    setIncluded(s);
                  }}
                >
                  {a.symbol}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted">
            Equal Weight · Min Variance · Max Sharpe · Risk Parity · Max
            Diversification · Min CVaR — ใช้ปฏิทินราคา ขอบเขตน้ำหนัก ต้นทุน
            และตัวประมาณ μ / Σ เดียวกัน ต่างกันที่วิธีเลือกน้ำหนักเท่านั้น
          </p>
          <p className="mt-1 text-xs text-muted">
            ใช้เฉพาะวันที่ทุกตัวมีราคาพร้อมกัน —
            ตัวที่ประวัติราคาสั้นจะทำให้ช่วงเปรียบเทียบสั้นลงทั้งชุด
          </p>
        </section>
      </div>

      {error && (
        <p role="alert" className="text-sm text-neg">
          {error}
        </p>
      )}

      {res && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="วิธีทดสอบ Out-of-Sample"
              className="inline-flex rounded-lg border border-border p-0.5 text-xs"
            >
              {(
                [
                  ["split", "แบ่งช่วงฝึก / ทดสอบ"],
                  ["walkForward", "Walk-forward"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={mode === k}
                  disabled={!res[k]}
                  className={clsx(
                    "rounded-md px-2.5 py-1 disabled:opacity-40",
                    mode === k
                      ? "bg-panel-2 font-medium text-text"
                      : "text-muted",
                  )}
                  onClick={() => setMode(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">
              {mode === "split" && res.split
                ? `ฝึก ${res.split.train.from} → ${res.split.train.to} (${res.split.train.observations} วัน) · ทดสอบ ${res.split.test.from} → ${res.split.test.to} (${res.split.test.observations} วัน)`
                : res.walkForward
                  ? `ทดสอบ ${res.walkForward.test.from} → ${res.walkForward.test.to} (${res.walkForward.test.observations} วัน) · ประมาณใหม่จาก ${res.walkForward.window} วันล่าสุดทุก ${res.input.rebalanceEveryObservations} วัน`
                  : ""}
            </p>
          </div>
          {res.warnings.map((w) => (
            <p key={w} className="text-xs text-warn">
              ⚠ {w}
            </p>
          ))}
          {res.excluded.length > 0 && (
            <p className="text-xs text-muted">
              ไม่รวม:{" "}
              {res.excluded.map((e) => `${e.symbol} (${e.reason})`).join(", ")}
            </p>
          )}

          {view && (
            <>
              <section className="card overflow-x-auto">
                <CardTitle
                  title={
                    mode === "split"
                      ? "น้ำหนักของแต่ละโมเดล (จากช่วงฝึก)"
                      : "น้ำหนักเป้าหมายล่าสุด (Walk-forward)"
                  }
                  className="mb-2"
                  explain={{
                    data: compact(
                      weightRows.map((r) => ({
                        โมเดล: MODEL_LABEL[r.model],
                        น้ำหนัก: r.w,
                      })),
                    ),
                  }}
                />
                <table className="table min-w-[560px]">
                  <thead>
                    <tr>
                      <th>โมเดล</th>
                      {res.symbols.map((s) => (
                        <th key={s} className="num">
                          {s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {weightRows.map((r) => (
                      <tr key={r.model}>
                        <td>
                          <ModelName model={r.model} />
                        </td>
                        {r.ok ? (
                          res.symbols.map((s) => {
                            const w = r.w[s] ?? 0;
                            return (
                              <td
                                key={s}
                                className="num"
                                style={{
                                  background:
                                    w > 0.0005
                                      ? `color-mix(in srgb, ${colorOf(r.model)} ${Math.round(Math.min(1, w) * 35)}%, transparent)`
                                      : undefined,
                                }}
                              >
                                {w > 0.0005 ? (
                                  fmtPct(w, 1)
                                ) : (
                                  <span className="text-muted">–</span>
                                )}
                              </td>
                            );
                          })
                        ) : (
                          <td
                            colSpan={res.symbols.length}
                            className="text-xs text-neg"
                          >
                            {
                              view.results.find((m) => m.model === r.model)
                                ?.error
                            }
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-muted">
                  ความเข้มของช่อง = สัดส่วนน้ำหนัก (ดูการกระจุกตัว) · “–” =
                  ไม่ถือ
                </p>
              </section>

              <section className="card overflow-x-auto">
                <CardTitle
                  title={
                    mode === "split"
                      ? "ค่าคาดการณ์ เทียบกับผลจริง"
                      : "ผล Out-of-Sample (Walk-forward)"
                  }
                  className="mb-2"
                  explain={{
                    data: compact({
                      วิธี: mode,
                      ช่วง:
                        mode === "split"
                          ? { ฝึก: res.split?.train, ทดสอบ: res.split?.test }
                          : res.walkForward?.test,
                      Rf: res.riskFreeRate,
                      ผล: view.results.map((m) => ({
                        โมเดล: MODEL_LABEL[m.model],
                        ...("exAnte" in m
                          ? {
                              คาดการณ์: m.exAnte,
                              InSample: m.inSample,
                              ส่วนต่าง: m.gap,
                            }
                          : {}),
                        OutOfSample: m.outOfSample,
                        error: m.error,
                      })),
                      อันดับตามSharpeOOS: view.ranking.map(
                        (m) => MODEL_LABEL[m],
                      ),
                      คำเตือน: res.warnings,
                    }),
                  }}
                />
                {mode === "split" && res.split ? (
                  <table className="table min-w-[1040px] text-xs">
                    <thead>
                      <tr>
                        <th rowSpan={2}>โมเดล</th>
                        <th
                          colSpan={3}
                          className="border-l border-border text-center"
                        >
                          คาดการณ์ (จากช่วงฝึก)
                        </th>
                        <th
                          colSpan={4}
                          className="border-l border-border text-center"
                        >
                          ผลจริงในช่วงฝึก (In-sample)
                        </th>
                        <th
                          colSpan={4}
                          className="border-l border-border text-center"
                        >
                          ผลจริงนอกช่วงฝึก (Out-of-Sample)
                        </th>
                        <th
                          colSpan={2}
                          className="border-l border-border text-center"
                        >
                          ส่วนต่าง / ต้นทุน
                        </th>
                      </tr>
                      <tr>
                        <th className="num border-l border-border">E[R]</th>
                        <th className="num" style={{ textTransform: "none" }}>
                          σ
                        </th>
                        <th className="num">Sharpe</th>
                        <th className="num border-l border-border">
                          ผลตอบแทน/ปี
                        </th>
                        <th className="num" style={{ textTransform: "none" }}>
                          σ
                        </th>
                        <th className="num">Sharpe</th>
                        <th className="num">Max DD</th>
                        <th className="num border-l border-border">
                          ผลตอบแทน/ปี
                        </th>
                        <th className="num" style={{ textTransform: "none" }}>
                          σ
                        </th>
                        <th className="num">Sharpe</th>
                        <th className="num">Max DD</th>
                        <th
                          className="num border-l border-border"
                          title="Sharpe ที่เกิดจริงนอกช่วงฝึก − Sharpe ที่คาดการณ์"
                        >
                          Δ Sharpe
                        </th>
                        <th className="num">ต้นทุน</th>
                      </tr>
                    </thead>
                    <tbody>
                      {res.split.results.map((m, i) => (
                        <tr key={m.model}>
                          <td>
                            <ModelName model={m.model} />
                          </td>
                          {m.ok && m.exAnte ? (
                            <>
                              <td className="num border-l border-border">
                                {fmtPct(m.exAnte.expectedReturn, 1)}
                              </td>
                              <td className="num">
                                {fmtPct(m.exAnte.volatility, 1)}
                              </td>
                              <td className="num">
                                {fmtRatio(m.exAnte.sharpe)}
                              </td>
                              <td className="num border-l border-border">
                                {ret(m.inSample)}
                              </td>
                              <td className="num">
                                {fmtPct(m.inSample?.volatility, 1)}
                              </td>
                              <td className="num">
                                {fmtRatio(m.inSample?.sharpe)}
                              </td>
                              <td className="num">
                                {fmtPct(m.inSample?.maxDrawdown, 1)}
                              </td>
                              <td
                                className={clsx(
                                  hi(best.ret === i),
                                  "border-l border-border",
                                )}
                              >
                                {ret(m.outOfSample)}
                              </td>
                              <td className={hi(best.vol === i)}>
                                {fmtPct(m.outOfSample?.volatility, 1)}
                              </td>
                              <td className={hi(best.sharpe === i)}>
                                {fmtRatio(m.outOfSample?.sharpe)}
                              </td>
                              <td className={hi(best.mdd === i)}>
                                {fmtPct(m.outOfSample?.maxDrawdown, 1)}
                              </td>
                              <td
                                className={clsx(
                                  "num border-l border-border",
                                  m.gap?.sharpe != null &&
                                    m.gap.sharpe < 0 &&
                                    "text-neg",
                                )}
                              >
                                {m.gap?.sharpe != null
                                  ? `${m.gap.sharpe >= 0 ? "+" : ""}${fmtRatio(m.gap.sharpe)}`
                                  : "–"}
                              </td>
                              <td className="num">
                                {m.costs != null ? fmtThb(m.costs) : "–"}
                              </td>
                            </>
                          ) : (
                            <td
                              colSpan={13}
                              className="border-l border-border text-neg"
                            >
                              {m.error}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  res.walkForward && (
                    <table className="table min-w-[720px] text-xs">
                      <thead>
                        <tr>
                          <th>โมเดล</th>
                          <th className="num">ผลตอบแทน/ปี</th>
                          <th className="num" style={{ textTransform: "none" }}>
                            σ
                          </th>
                          <th className="num">Sharpe</th>
                          <th className="num">Sortino</th>
                          <th className="num">Max DD</th>
                          <th className="num">ปรับพอร์ต</th>
                          <th className="num">Turnover/ปี</th>
                          <th className="num">ต้นทุน</th>
                        </tr>
                      </thead>
                      <tbody>
                        {res.walkForward.results.map((m, i) => (
                          <tr key={m.model}>
                            <td>
                              <ModelName model={m.model} />
                            </td>
                            {m.ok ? (
                              <>
                                <td className={hi(best.ret === i)}>
                                  {ret(m.outOfSample)}
                                </td>
                                <td className={hi(best.vol === i)}>
                                  {fmtPct(m.outOfSample?.volatility, 1)}
                                </td>
                                <td className={hi(best.sharpe === i)}>
                                  {fmtRatio(m.outOfSample?.sharpe)}
                                </td>
                                <td className="num">
                                  {fmtRatio(m.outOfSample?.sortino)}
                                </td>
                                <td className={hi(best.mdd === i)}>
                                  {fmtPct(m.outOfSample?.maxDrawdown, 1)}
                                </td>
                                <td className="num">{m.rebalances}</td>
                                <td className="num">
                                  {fmtPct(m.turnoverAnnual, 0)}
                                </td>
                                <td className="num">
                                  {m.costs != null ? fmtThb(m.costs) : "–"}
                                </td>
                              </>
                            ) : (
                              <td colSpan={8} className="text-neg">
                                {m.error}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}
                <p className="mt-2 text-xs text-muted">
                  ตัวหนาสีเขียว = ดีที่สุดในคอลัมน์ Out-of-Sample (ผลตอบแทนและ
                  Sharpe สูงสุด · σ และ Max DD ต่ำสุด) · Rf{" "}
                  {fmtPct(res.riskFreeRate, 2)}
                  {anyExtrapolated &&
                    " · * ช่วงสั้นกว่า 1 ปี: ผลตอบแทนต่อปีเป็นค่าเทียบเท่า (ขยายจากช่วงจริง) ไม่ใช่ CAGR"}
                  {mode === "split" &&
                    " · Max Drawdown ไม่มีค่าคาดการณ์ล่วงหน้า จึงมีเฉพาะค่าที่เกิดจริง"}
                </p>
                {view.results
                  .flatMap((m) =>
                    m.notes.map((n) => `${MODEL_LABEL[m.model]}: ${n}`),
                  )
                  .map((n) => (
                    <p key={n} className="mt-1 text-xs text-warn">
                      ⚠ {n}
                    </p>
                  ))}
              </section>

              {okModels.length > 0 && (
                <div className="grid gap-6 lg:grid-cols-2">
                  <section className="card min-w-0">
                    <h2 className="mb-2 text-[15px] font-semibold">
                      มูลค่าพอร์ตนอกช่วงฝึก{" "}
                      <span className="text-xs font-normal text-muted">
                        (ฐาน 100 ณ วันเริ่มทดสอบ)
                      </span>
                    </h2>
                    <ModelLinesChart
                      data={view.curve}
                      series={okModels}
                      benchmark={res.benchmark?.symbol}
                    />
                  </section>
                  <section className="card min-w-0">
                    <h2 className="mb-2 text-[15px] font-semibold">
                      Drawdown นอกช่วงฝึก{" "}
                      <span className="text-xs font-normal text-muted">
                        (ลดลงจากจุดสูงสุดก่อนหน้า)
                      </span>
                    </h2>
                    <ModelLinesChart
                      data={view.drawdown}
                      series={okModels}
                      benchmark={res.benchmark?.symbol}
                      percent
                    />
                  </section>
                </div>
              )}
            </>
          )}

          <section className="card space-y-1 text-xs text-muted">
            <h2 className="text-[15px] font-semibold text-text">
              วิธีคำนวณและข้อจำกัด
            </h2>
            <ul className="list-disc space-y-0.5 pl-4">
              {[...res.methodology, ...res.limitations].map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
