"use client";

import { useState } from "react";
import clsx from "clsx";
import { DrawdownChart, GrowthChart, WeightsChart } from "./charts";
import { NumField, SelectField, Toggle } from "./fields";
import { ASSET_CLASS_LABEL, fmtNum, fmtPct, fmtRatio, fmtThb, signClass } from "@/lib/format";
import type { BacktestResult, BacktestStrategy } from "@/lib/finance/backtest";
import type { AssetClass } from "@/db/schema";

type Asset = { symbol: string; assetClass: AssetClass; from: string; to: string; count: number };
type Response = BacktestResult & { universe: string[]; excluded: { symbol: string; reason: string }[]; limitations: string[]; input: { rebalanceEveryObservations: number } };

const STRATEGIES: { value: BacktestStrategy; label: string }[] = [
  { value: "equal_weight", label: "Equal weight (ปรับกลับเท่ากันทุกรอบ)" },
  { value: "min_variance", label: "Minimum variance" },
  { value: "max_sharpe", label: "Max Sharpe" },
  { value: "black_litterman", label: "Black–Litterman (น้ำหนักตลาด + views)" },
  { value: "custom", label: "น้ำหนักที่กำหนดเอง (ปรับกลับทุกรอบ)" },
  { value: "buy_and_hold", label: "Buy and hold (ไม่ปรับ)" },
];
const COMPARE: BacktestStrategy[] = ["buy_and_hold", "equal_weight", "min_variance", "max_sharpe"];

export function BacktestClient({ assets }: { assets: Asset[] }) {
  const [included, setIncluded] = useState<Set<string>>(new Set(assets.map((a) => a.symbol)));
  const [strategy, setStrategy] = useState<BacktestStrategy>("max_sharpe");
  const [weights, setWeights] = useState<Record<string, number | null>>({});
  const [startDate, setStartDate] = useState("");
  const [windowDays, setWindowDays] = useState(252);
  const [rebalance, setRebalance] = useState<"monthly" | "quarterly" | "semiannual" | "annual">("quarterly");
  const [returnMethod, setReturnMethod] = useState<"historical" | "capm" | "blend">("historical");
  const [covMethod, setCovMethod] = useState<"sample" | "ledoit_wolf">("ledoit_wolf");
  const [minW, setMinW] = useState(0);
  const [maxW, setMaxW] = useState(0.5);
  const [capital, setCapital] = useState(1_000_000);
  const [useCosts, setUseCosts] = useState(true);
  const [useLots, setUseLots] = useState(false);
  const [res, setRes] = useState<Response | null>(null);
  const [compare, setCompare] = useState<{ strategy: BacktestStrategy; r: Response | null; error?: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const body = (s: BacktestStrategy) => {
    const w = Object.fromEntries(Object.entries(weights).filter((e): e is [string, number] => e[1] != null && included.has(e[0])));
    return {
      strategy: s,
      symbols: [...included],
      ...(startDate ? { startDate } : {}),
      windowDays,
      rebalance,
      returnMethod,
      covMethod,
      minWeight: minW,
      maxWeight: maxW,
      initialCapital: capital,
      useCosts,
      useLots,
      ...(s === "custom" || (s === "buy_and_hold" && Object.keys(w).length) ? { weights: w } : {}),
      ...(s === "black_litterman" ? { blackLitterman: { marketWeights: w, views: [] } } : {}),
    };
  };
  const call = async (s: BacktestStrategy): Promise<Response> => {
    const r = await fetch("/api/v1/portfolio/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(s)) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? data.issues?.map((i: { message: string }) => i.message).join(", ") ?? `HTTP ${r.status}`);
    return data;
  };
  async function run() {
    setPending(true);
    setError(null);
    try {
      setRes(await call(strategy));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRes(null);
    } finally {
      setPending(false);
    }
  }
  async function runCompare() {
    setPending(true);
    setError(null);
    const out: NonNullable<typeof compare> = [];
    for (const s of COMPARE) {
      try {
        out.push({ strategy: s, r: await call(s) });
      } catch (e) {
        out.push({ strategy: s, r: null, error: e instanceof Error ? e.message : String(e) });
      }
    }
    setCompare(out);
    setPending(false);
  }

  const needsWeights = strategy === "custom" || strategy === "black_litterman";
  const m = res?.metrics;
  const symbols = res?.universe ?? [];
  const weightRows = res?.weights.map((w) => ({ date: w.date, ...w.actual, เงินสด: w.cash })) ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card space-y-3">
          <h2 className="font-semibold">กลยุทธ์</h2>
          <SelectField label="กลยุทธ์" value={strategy} options={STRATEGIES} onChange={setStrategy} />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">เริ่ม (ว่าง = วันที่ทุกตัวมีราคา)</span>
              <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
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
            <NumField label="ช่วงฝึก (จำนวนวันที่มีราคา)" value={windowDays} onChange={(v) => setWindowDays(Math.max(30, Math.round(v ?? 252)))} />
            <NumField label="เงินเริ่มต้น (บาท)" value={capital} onChange={(v) => setCapital(Math.max(1, v ?? 1_000_000))} />
            <SelectField
              label="ผลตอบแทนคาดหวัง"
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
            <NumField label="น้ำหนักต่ำสุด/ตัว" pct value={minW} onChange={(v) => setMinW(Math.max(0, v ?? 0))} />
            <NumField label="น้ำหนักสูงสุด/ตัว" pct value={maxW} onChange={(v) => setMaxW(Math.min(1, Math.max(0.01, v ?? 1)))} />
          </div>
          <Toggle label="หักต้นทุนการซื้อขาย (จากหน้าตั้งค่า)" checked={useCosts} onChange={setUseCosts} />
          <Toggle label="ซื้อขายเป็น lot (ไม่ซื้อเศษหน่วย)" checked={useLots} onChange={setUseLots} />
          <div className="flex flex-wrap gap-2 pt-1">
            <button className="btn" onClick={run} disabled={pending || included.size < 1}>
              {pending ? "กำลังทดสอบ…" : "รัน backtest"}
            </button>
            <button className="btn-ghost" onClick={runCompare} disabled={pending || included.size < 2}>
              เทียบ 4 กลยุทธ์
            </button>
          </div>
        </section>

        <section className="card overflow-x-auto lg:col-span-2">
          <h2 className="mb-2 font-semibold">สินทรัพย์ {needsWeights && <span className="text-xs font-normal text-muted">— {strategy === "black_litterman" ? "ใส่น้ำหนักตลาด (%)" : "ใส่น้ำหนักเป้าหมาย (%) ที่เหลือเป็นเงินสด"}</span>}</h2>
          <table className="table">
            <thead>
              <tr>
                <th>ใช้</th>
                <th>สินทรัพย์</th>
                <th>ราคาตั้งแต่</th>
                <th className="num">จำนวนวัน</th>
                {(needsWeights || strategy === "buy_and_hold") && <th className="num w-28">น้ำหนัก (%)</th>}
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
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
                  </td>
                  <td className="text-xs">{a.from}</td>
                  <td className="num">{a.count}</td>
                  {(needsWeights || strategy === "buy_and_hold") && (
                    <td className="num">
                      <input
                        className="input w-20 text-right"
                        inputMode="decimal"
                        placeholder={strategy === "buy_and_hold" ? "เท่ากัน" : "0"}
                        value={weights[a.symbol] != null ? String(+(weights[a.symbol]! * 100).toFixed(2)) : ""}
                        onChange={(e) => setWeights((w) => ({ ...w, [a.symbol]: e.target.value.trim() === "" || !Number.isFinite(Number(e.target.value)) ? null : Number(e.target.value) / 100 }))}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">วันเริ่มต้นจริง = วันที่ทุกสินทรัพย์ที่เลือกมีราคา · กลยุทธ์ที่ใช้ optimizer เริ่มซื้อขายหลังช่วงฝึก</p>
        </section>
      </div>

      {error && <p className="text-sm text-neg">{error}</p>}

      {compare && (
        <section className="card overflow-x-auto">
          <h2 className="mb-2 font-semibold">เปรียบเทียบกลยุทธ์ (เงื่อนไขเดียวกัน)</h2>
          <table className="table">
            <thead>
              <tr>
                <th>กลยุทธ์</th>
                <th>ช่วง</th>
                <th className="num">ผลตอบแทน</th>
                <th className="num">ต่อปี</th>
                <th className="num">σ</th>
                <th className="num">Sharpe</th>
                <th className="num">Max DD</th>
                <th className="num">ต้นทุน</th>
                <th className="num">Turnover/ปี</th>
              </tr>
            </thead>
            <tbody>
              {compare.map(({ strategy: s, r, error: e }) => (
                <tr key={s}>
                  <td className="font-medium">{STRATEGIES.find((x) => x.value === s)?.label}</td>
                  {r ? (
                    <>
                      <td className="text-xs">{r.period.from} → {r.period.to}</td>
                      <td className={clsx("num", signClass(r.metrics.cumulativeReturn))}>{fmtPct(r.metrics.cumulativeReturn, 1)}</td>
                      <td className="num">{fmtPct(r.metrics.annualizedReturn ?? r.metrics.annualizedEquivalent, 1)}</td>
                      <td className="num">{fmtPct(r.metrics.volatility, 1)}</td>
                      <td className="num">{fmtRatio(r.metrics.sharpe)}</td>
                      <td className="num text-neg">{fmtPct(r.metrics.maxDrawdown, 1)}</td>
                      <td className="num">{fmtThb(r.costs.total)}</td>
                      <td className="num">{fmtPct(r.turnover.annualized, 0)}</td>
                    </>
                  ) : (
                    <td colSpan={8} className="text-xs text-neg">{e}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">กลยุทธ์ที่ใช้ optimizer เริ่มหลังช่วงฝึก ช่วงเวลาจึงสั้นกว่า buy and hold / equal weight — เทียบด้วยค่าต่อปีและ Sharpe</p>
        </section>
      )}

      {res && m && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
            <Stat k={m.annualizationApplicable ? "ผลตอบแทนต่อปี (CAGR)" : "ผลตอบแทนสะสม"} v={fmtPct(m.annualizationApplicable ? m.annualizedReturn : m.cumulativeReturn, 2)} tone={signClass(m.cumulativeReturn)} />
            <Stat k="ความผันผวน" v={fmtPct(m.volatility, 1)} />
            <Stat k="Sharpe / Sortino" v={`${fmtRatio(m.sharpe)} / ${fmtRatio(m.sortino)}`} />
            <Stat k="Max drawdown" v={fmtPct(m.maxDrawdown, 1)} tone="text-neg" />
            <Stat k={`β / α (vs ${m.benchmark?.symbol ?? "–"})`} v={`${fmtRatio(m.benchmark?.regressionBeta ?? null)} / ${fmtPct(m.benchmark?.regressionAlphaAnnual ?? null, 1)}`} />
            <Stat k="Tracking error / IR" v={`${fmtPct(m.benchmark?.trackingError ?? null, 1)} / ${fmtRatio(m.benchmark?.informationRatio ?? null)}`} />
          </div>

          <section className="card">
            <h2 className="mb-1 font-semibold">Equity curve เทียบดัชนี</h2>
            <p className="mb-2 text-xs text-muted">
              {res.period.from} → {res.period.to} · {res.period.rebalances} รอบปรับพอร์ต (ทุก {res.input.rebalanceEveryObservations} วันที่มีราคา) · มูลค่าสุดท้าย {fmtThb(res.values.at(-1)!.value)} · ดัชนี{" "}
              {m.benchmark ? fmtPct(m.benchmark.cumulative, 1) : "–"}
            </p>
            <GrowthChart data={m.growth} benchmark={m.benchmark?.symbol} />
            <h3 className="mt-4 mb-1 text-sm font-semibold">Drawdown</h3>
            <DrawdownChart data={res.drawdown} />
          </section>

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="card lg:col-span-2">
              <h2 className="mb-2 font-semibold">น้ำหนักหลังปรับพอร์ตแต่ละรอบ</h2>
              <WeightsChart data={weightRows} symbols={symbols} />
            </section>
            <section className="card space-y-1 text-sm">
              <h2 className="mb-2 font-semibold">ต้นทุนการซื้อขาย</h2>
              <KV k="ค่าคอมมิชชัน" v={fmtThb(res.costs.commission)} />
              <KV k="VAT" v={fmtThb(res.costs.vat)} />
              <KV k="Slippage" v={fmtThb(res.costs.slippage)} />
              <KV k="ภาษีขาย" v={fmtThb(res.costs.tax)} />
              <KV k="รวม (% ของเงินเริ่มต้น)" v={`${fmtThb(res.costs.total)} (${fmtPct(res.costs.shareOfInitial, 2)})`} />
              <KV k="Turnover รวม / ต่อปี" v={`${fmtPct(res.turnover.total, 0)} / ${fmtPct(res.turnover.annualized, 0)}`} />
              <KV k="จำนวนรายการ" v={String(res.trades.length)} />
            </section>
          </div>

          <section className="card overflow-x-auto">
            <h2 className="mb-2 font-semibold">ประวัติการซื้อขาย {res.trades.length > 200 && <span className="text-xs font-normal text-muted">(แสดง 200 รายการล่าสุด)</span>}</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>สินทรัพย์</th>
                  <th>คำสั่ง</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ราคา (บาท)</th>
                  <th className="num">มูลค่า</th>
                  <th className="num">ต้นทุน</th>
                </tr>
              </thead>
              <tbody>
                {res.trades.slice(-200).reverse().map((t, i) => (
                  <tr key={i}>
                    <td>{t.date}</td>
                    <td className="font-medium">{t.symbol}</td>
                    <td className={t.side === "buy" ? "text-pos" : "text-neg"}>{t.side === "buy" ? "ซื้อ" : "ขาย"}</td>
                    <td className="num">{fmtNum(t.quantity, t.quantity % 1 ? 4 : 0)}</td>
                    <td className="num">{fmtNum(t.price)}</td>
                    <td className="num">{fmtThb(t.value)}</td>
                    <td className="num">{fmtNum(t.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card space-y-2 text-xs text-muted">
            <h2 className="text-sm font-semibold text-[var(--text)]">วิธีคำนวณและข้อจำกัด</h2>
            <ul className="list-disc space-y-1 pl-5">
              {[...res.methodology, ...res.limitations].map((t) => (
                <li key={t}>{t}</li>
              ))}
              {res.excluded.map((e) => (
                <li key={e.symbol} className="text-neg">ไม่รวม {e.symbol}: {e.reason}</li>
              ))}
              {[...res.warnings, ...m.dataQuality.warnings].map((w) => (
                <li key={w} className="text-neg">{w}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="card">
      <div className="text-xs text-muted">{k}</div>
      <div className={clsx("mt-1 text-lg font-semibold tabular-nums", tone)}>{v}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1.5">
      <span className="text-muted">{k}</span>
      <span className="font-medium tabular-nums">{v}</span>
    </div>
  );
}
