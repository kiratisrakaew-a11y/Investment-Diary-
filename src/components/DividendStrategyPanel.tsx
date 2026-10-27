"use client";

import { Fragment, useState } from "react";
import clsx from "clsx";
import { DIVIDEND_PRESETS, DIVIDEND_STRATEGY_IDS, FACTOR_KEYS, FACTOR_LABEL, resolveSettings, type DividendStrategyId, type FactorKey, type StrategySettings } from "@/lib/finance/dividend-strategies";
import type { screenDividendStocks } from "@/server/services/strategies";
import { fmtNum, fmtPct } from "@/lib/format";
import { compact } from "@/lib/explain-data";
import { NumField, SelectField, Toggle } from "./fields";
import { CardTitle, ExplainButton } from "./ExplainButton";
import { RebalancePanel } from "./RebalancePanel";
import { Badge } from "./ui";

type Result = Awaited<ReturnType<typeof screenDividendStocks>>;

const PCT: Partial<Record<FactorKey, true>> = { ttmYieldRegular: true, earningsPayout: true, fcfPayout: true, dpsCagr3: true, dpsCagr5: true, roe: true, fcfStability: true, marginOfSafety: true, yieldVsHistory: true };
const fmtFactor = (k: FactorKey, v: number | null) => (v == null ? "–" : PCT[k] ? fmtPct(v, 1) : k === "consistencyYears" ? `${v} ปี` : fmtNum(v, 2));

const CODE_LABEL: Record<string, string> = {
  no_price: "ไม่มีราคา",
  no_dividend_history: "ไม่มีข้อมูลปันผล",
  insufficient_data: "ข้อมูลไม่พอ",
  below_min_yield: "yield ต่ำกว่าเกณฑ์",
  short_history: "ประวัติสั้น",
  below_min_consecutive_years: "จ่ายต่อเนื่องไม่ถึง",
  payout_not_meaningful: "อัตราจ่ายไม่มีความหมาย (EPS ≤ 0)",
  payout_above_max: "อัตราจ่ายสูงเกิน",
  negative_fcf: "FCF ติดลบ",
  fcf_payout_above_max: "จ่ายเกิน FCF",
  dps_cagr_below_min: "ปันผลไม่โตตามเกณฑ์",
  leverage_above_max: "หนี้สูงเกิน",
  yield_inflated_by_price_drop: "yield สูงเพราะราคาร่วง",
  low_factor_coverage: "ข้อมูลปัจจัยไม่ครบ",
};

export function DividendStrategyPanel({ symbols }: { symbols: string[] }) {
  const [strategy, setStrategy] = useState<DividendStrategyId>("dividend_sustainable_income");
  const [s, setS] = useState<StrategySettings>(() => resolveSettings("dividend_sustainable_income"));
  const [asOf, setAsOf] = useState("");
  const [pit, setPit] = useState<"strict" | "illustrative_lookahead">("strict");
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const pickPreset = (id: DividendStrategyId) => {
    setStrategy(id);
    setS(resolveSettings(id));
    setRes(null);
  };
  const setFilter = <K extends keyof StrategySettings["filters"]>(k: K, v: StrategySettings["filters"][K]) => setS({ ...s, filters: { ...s.filters, [k]: v } });
  const setFactor = (k: FactorKey, patch: { weight?: number; required?: boolean }) => {
    const cur = s.factors[k] ?? { weight: 0, required: false };
    setS({ ...s, factors: { ...s.factors, [k]: { ...cur, ...patch } } });
  };

  async function run() {
    setPending(true);
    setError(null);
    try {
      const factors = Object.fromEntries(Object.entries(s.factors).filter(([, f]) => f && f.weight > 0));
      const r = await fetch("/api/v1/dividends/screen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy, asOf: asOf || undefined, pointInTime: pit, settings: { ...s, factors } }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? data.issues?.map((i: { message: string }) => i.message).join(", ") ?? `HTTP ${r.status}`);
      setRes(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  const preset = DIVIDEND_PRESETS[strategy];
  const weightSum = Object.values(s.factors).reduce((a, f) => a + (f?.weight ?? 0), 0);
  return (
    <div className="space-y-5">
      <section className="card space-y-4">
        <CardTitle title="ตัวคัดกรองหุ้นปันผล" />
        <div className="grid gap-3 md:grid-cols-3">
          {DIVIDEND_STRATEGY_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => pickPreset(id)}
              className={clsx("rounded-xl border p-3 text-left transition-colors", id === strategy ? "border-accent bg-accent/10" : "border-border bg-panel-2 hover:border-accent/50")}
            >
              <div className="font-semibold">{DIVIDEND_PRESETS[id].label}</div>
              <div className="mt-1 text-xs text-muted">{DIVIDEND_PRESETS[id].description}</div>
              <div className="mt-2 text-[11px] text-muted">เวอร์ชัน {DIVIDEND_PRESETS[id].version}</div>
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="label">ณ วันที่ (ว่าง = วันนี้)</span>
            <input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <SelectField
            label="ข้อมูลงบ ณ วันนั้น"
            value={pit}
            onChange={setPit}
            options={[
              { value: "strict", label: "เข้ม: ใช้เฉพาะงบที่เผยแพร่แล้ว" },
              { value: "illustrative_lookahead", label: "ภาพประกอบ: ใช้งบที่ไม่มีวันเผยแพร่ (look-ahead)" },
            ]}
          />
          <SelectField
            label="วิธีให้น้ำหนัก"
            value={s.weighting}
            onChange={(v) => setS({ ...s, weighting: v })}
            options={[
              { value: "equal", label: "เท่ากัน" },
              { value: "score", label: "ตามคะแนน" },
              { value: "optimizer", label: "optimizer เดิม (min variance)" },
            ]}
          />
          <NumField label="จำนวนหุ้นสูงสุด (top N)" value={s.topN} onChange={(v) => setS({ ...s, topN: Math.max(1, Math.round(v ?? 10)) })} />
          <NumField label="น้ำหนักสูงสุด/ตัว" pct value={s.maxWeight} onChange={(v) => setS({ ...s, maxWeight: v ?? 0.25 })} />
          <NumField label="สูงสุด/ผู้ออก" pct nullable value={s.maxPerIssuer} onChange={(v) => setS({ ...s, maxPerIssuer: v })} />
          <NumField label="สูงสุด/หมวด" pct nullable value={s.maxPerSector} onChange={(v) => setS({ ...s, maxPerSector: v })} />
          <NumField label="เงินสดสำรอง" pct value={s.cashReserve} onChange={(v) => setS({ ...s, cashReserve: v ?? 0 })} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Toggle label="รวมปันผลพิเศษใน yield รวม" checked={s.includeSpecial} onChange={(v) => setS({ ...s, includeSpecial: v })} />
          <button type="button" className="btn-ghost text-xs" onClick={() => setShowSettings(!showSettings)}>
            {showSettings ? "ซ่อน" : "แก้"}เกณฑ์และน้ำหนักปัจจัย
          </button>
        </div>

        {showSettings && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">เกณฑ์คัดกรอง (ว่าง = ไม่ใช้)</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumField label="Yield ปกติขั้นต่ำ" pct nullable value={s.filters.minYield} onChange={(v) => setFilter("minYield", v)} />
                <NumField label="จ่ายต่อเนื่องขั้นต่ำ (ปี)" nullable value={s.filters.minConsecutiveYears} onChange={(v) => setFilter("minConsecutiveYears", v == null ? null : Math.round(v))} />
                <NumField label="ประวัติปันผลขั้นต่ำ (ปี)" nullable value={s.filters.minHistoryYears} onChange={(v) => setFilter("minHistoryYears", v == null ? null : Math.round(v))} />
                <NumField label="อัตราจ่ายจากกำไรสูงสุด" pct nullable value={s.filters.maxEarningsPayout} onChange={(v) => setFilter("maxEarningsPayout", v)} />
                <NumField label="อัตราจ่ายจาก FCF สูงสุด" pct nullable value={s.filters.maxFcfPayout} onChange={(v) => setFilter("maxFcfPayout", v)} />
                <NumField label="DPS โต 5 ปี ขั้นต่ำ" pct nullable value={s.filters.minDpsCagr5} onChange={(v) => setFilter("minDpsCagr5", v)} />
                <NumField label="Net debt/EBITDA สูงสุด" nullable value={s.filters.maxNetDebtToEbitda} onChange={(v) => setFilter("maxNetDebtToEbitda", v)} />
                <NumField label="คะแนนต้องมีข้อมูลอย่างน้อย" pct value={s.minCoverage} onChange={(v) => setS({ ...s, minCoverage: v ?? 0.6 })} />
              </div>
              <div className="mt-3 space-y-2">
                <Toggle label="ตัด FCF ติดลบ (ยกเว้นกลุ่มการเงิน)" checked={s.filters.excludeNegativeFcf} onChange={(v) => setFilter("excludeNegativeFcf", v)} />
                <Toggle label="ตัด yield ที่สูงเพราะราคาร่วง ≥ 25%" checked={s.filters.excludeYieldFromPriceDrop} onChange={(v) => setFilter("excludeYieldFromPriceDrop", v)} />
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">
                น้ำหนักปัจจัย <span className="font-normal text-muted">(รวม {(weightSum * 100).toFixed(0)}% — คำนวณสัดส่วนใหม่อัตโนมัติ)</span>
              </h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>ปัจจัย</th>
                    <th className="num">น้ำหนัก (%)</th>
                    <th>จำเป็น</th>
                  </tr>
                </thead>
                <tbody>
                  {FACTOR_KEYS.map((k) => (
                    <tr key={k}>
                      <td className="text-xs">{FACTOR_LABEL[k]}</td>
                      <td className="num w-24">
                        <input
                          className="input py-0.5 text-right"
                          inputMode="decimal"
                          value={Math.round((s.factors[k]?.weight ?? 0) * 100)}
                          onChange={(e) => setFactor(k, { weight: Math.min(1, Math.max(0, Number(e.target.value) / 100 || 0)) })}
                        />
                      </td>
                      <td>
                        <input type="checkbox" className="accent-[var(--accent)]" checked={!!s.factors[k]?.required} onChange={(e) => setFactor(k, { required: e.target.checked })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" onClick={run} disabled={pending || !symbols.length}>
            {pending ? "กำลังคัดกรอง…" : `คัดกรองด้วย “${preset.label}”`}
          </button>
          <span className="text-xs text-muted">ค่าเริ่มต้นเป็นตัวอย่างที่แก้ได้ ไม่ใช่คำแนะนำการลงทุน · จักรวาล: {symbols.join(", ") || "–"}</span>
        </div>
        {error && <p className="text-sm text-neg">{error}</p>}
      </section>

      {res && (
        <>
          <section className="card overflow-x-auto">
            <CardTitle
              title={`ผลคัดกรอง ณ ${res.asOf}`}
              explain={{
                data: compact({ กลยุทธ์: res.strategy, เลือก: res.selected, น้ำหนัก: res.targetWeights, อันดับ: res.ranked.map((r) => ({ symbol: r.symbol, score: r.score, coverage: r.coverage, factors: r.factors.map((f) => ({ key: f.key, value: f.value, rank: f.rank })) })), ตัดออก: res.excluded }),
                hint: "คะแนน = ค่าเฉลี่ยถ่วงน้ำหนักของอันดับเปอร์เซ็นไทล์ในแต่ละปัจจัย (0–1); ข้อมูลที่ขาดไม่ถูกเติมเป็น 0",
              }}
            >
              <Badge className="ml-2 align-middle">{res.sourceStatus === "verified" ? "ข้อมูลครบ" : res.sourceStatus === "partial" ? "ข้อมูลบางส่วน" : "ข้อมูลไม่พอ"}</Badge>
            </CardTitle>
            {res.ranked.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>หุ้น</th>
                    <th className="min-w-32">คะแนน</th>
                    <th className="num">Yield ปกติ</th>
                    <th className="num">Payout</th>
                    <th className="num">FCF payout</th>
                    <th className="num">DPS โต 5 ปี</th>
                    <th className="num">จ่ายต่อเนื่อง</th>
                    <th className="num">น้ำหนักเป้า</th>
                  </tr>
                </thead>
                <tbody>
                  {res.ranked.map((r, i) => {
                    const p = res.profiles[r.symbol];
                    const w = res.targetWeights[r.symbol];
                    return (
                      <Fragment key={r.symbol}>
                        <tr className="cursor-pointer" onClick={() => setOpen(open === r.symbol ? null : r.symbol)}>
                          <td className="text-muted">{i + 1}</td>
                          <td className="font-medium">
                            {r.symbol} {res.selected.includes(r.symbol) && <span className="text-xs text-accent">● เลือก</span>}
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-20 rounded-full bg-panel-2">
                                <div className="h-2 rounded-full bg-linear-to-r from-accent to-accent-2" style={{ width: `${r.score * 100}%` }} />
                              </div>
                              <span className="tabular-nums">{r.score.toFixed(2)}</span>
                              {r.coverage < 1 && <span className="text-[11px] text-warn">{(r.coverage * 100).toFixed(0)}%</span>}
                            </div>
                          </td>
                          <td className="num">{fmtPct(p.ttmYieldRegular.value, 2)}</td>
                          <td className="num">{p.earningsPayout.value == null ? <span className="text-muted">{p.earningsPayout.status}</span> : fmtPct(p.earningsPayout.value, 0)}</td>
                          <td className="num">{p.fcfPayout.value == null ? <span className="text-muted">{p.fcfPayout.status}</span> : fmtPct(p.fcfPayout.value, 0)}</td>
                          <td className="num">{fmtPct(p.dpsCagr5.value, 1)}</td>
                          <td className="num">{p.consistency.consecutiveYears.value ?? "–"}</td>
                          <td className="num font-medium">{w ? fmtPct(w, 1) : "–"}</td>
                        </tr>
                        {open === r.symbol && (
                          <tr>
                            <td colSpan={9} className="bg-panel-2/50 whitespace-normal">
                              <div className="grid gap-1 py-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                                {r.factors.map((f) => (
                                  <div key={f.key} className="flex justify-between gap-2 rounded-md px-2 py-1">
                                    <span className="text-muted">{FACTOR_LABEL[f.key]}</span>
                                    <span className="tabular-nums">
                                      {fmtFactor(f.key, f.value)}
                                      {f.rank != null ? ` · เปอร์เซ็นไทล์ ${(f.rank * 100).toFixed(0)}` : ` · ${f.status}`}
                                      {f.contribution != null && <span className="text-accent"> +{f.contribution.toFixed(2)}</span>}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              {r.warnings.map((w2) => (
                                <p key={w2} className="mt-1 text-[11px] text-warn">
                                  {w2}
                                </p>
                              ))}
                              <p className="mt-1 text-[11px] text-muted">
                                Yield รวม {fmtPct(p.ttmYieldTotal.value, 2)} · Forward {p.forwardYield.value == null ? p.forwardYield.warnings[0] : fmtPct(p.forwardYield.value, 2)} · ปันผลรายปีจาก{" "}
                                {p.annualDps.source === "statements" ? "งบการเงิน" : p.annualDps.source === "events" ? "เหตุการณ์ปันผล" : "–"} · ลด {p.consistency.cuts} ครั้ง · งด {p.consistency.missedYears} ปี · Total shareholder yield: ไม่รองรับ (ไม่มีข้อมูลซื้อหุ้นคืน)
                              </p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">ไม่มีหุ้นผ่านเกณฑ์</p>
            )}
            {res.diagnostics.length > 0 && (
              <ul className="mt-3 space-y-0.5 text-xs text-muted">
                {res.diagnostics.map((d) => (
                  <li key={d}>⚠ {d}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted">{res.disclaimer}</p>
          </section>

          {res.excluded.length > 0 && (
            <section className="card overflow-x-auto">
              <CardTitle title="ไม่ผ่านเกณฑ์ / ข้อมูลไม่พอ" explain={{ data: res.excluded, hint: "อธิบายว่าแต่ละเหตุผลหมายถึงอะไร และต้องมีข้อมูลอะไรเพิ่ม" }} />
              <table className="table">
                <thead>
                  <tr>
                    <th>หุ้น</th>
                    <th>เหตุผล</th>
                    <th>รายละเอียด</th>
                  </tr>
                </thead>
                <tbody>
                  {res.excluded.map((e) => (
                    <tr key={e.symbol}>
                      <td className="font-medium">{e.symbol}</td>
                      <td>
                        <Badge>{CODE_LABEL[e.code] ?? e.code}</Badge>
                      </td>
                      <td className="text-xs whitespace-normal text-muted">{e.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {Object.keys(res.targetWeights).length > 0 && (
            <>
              <div className="flex justify-end">
                <ExplainButton topic="น้ำหนักเป้าหมายจากกลยุทธ์ปันผล" data={compact({ น้ำหนัก: res.targetWeights, เพดาน: { maxWeight: res.settings.maxWeight, issuer: res.settings.maxPerIssuer, sector: res.settings.maxPerSector, cashReserve: res.settings.cashReserve } })} />
              </div>
              <RebalancePanel suggested={Object.entries(res.targetWeights).map(([symbol, weight]) => ({ symbol, weight }))} extraCash={0} sourceLabel="กลยุทธ์ปันผล" />
            </>
          )}
        </>
      )}
    </div>
  );
}
