"use client";

import { Fragment, useState } from "react";
import { FACTOR_FAMILIES, FAMILY_LABEL, factorSettingsSchema, type FactorSettings, type FactorStrategyId } from "@/lib/finance/factor-strategies";
import type { screenFactorStocks } from "@/server/services/strategies";
import { fmtNum, fmtPct } from "@/lib/format";
import { compact } from "@/lib/explain-data";
import { NumField, SelectField, Toggle } from "./fields";
import { CardTitle } from "./ExplainButton";
import { RebalancePanel } from "./RebalancePanel";
import { Badge } from "./ui";

type Result = Awaited<ReturnType<typeof screenFactorStocks>>;

const STRATEGIES: { value: FactorStrategyId; label: string }[] = [
  { value: "multi_factor", label: "Multi-factor (ผสมหลายปัจจัย)" },
  { value: "value", label: "Value — ถูกเทียบพื้นฐาน" },
  { value: "quality", label: "Quality — กิจการคุณภาพ" },
  { value: "momentum", label: "Momentum 12–1 เดือน" },
];
const PCT_KEYS = new Set(["earningsYield", "marginOfSafety", "roe", "fcfStability", "momentum", "ttmYieldRegular"]);

export function FactorStrategyPanel({ symbols }: { symbols: string[] }) {
  const [strategy, setStrategy] = useState<FactorStrategyId>("multi_factor");
  const [s, setS] = useState<FactorSettings>(() => factorSettingsSchema.parse({}));
  const [asOf, setAsOf] = useState("");
  const [pit, setPit] = useState<"strict" | "illustrative_lookahead">("strict");
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/strategies/factors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy, asOf: asOf || undefined, pointInTime: pit, settings: s }),
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

  const fw = s.familyWeights;
  return (
    <div className="space-y-5">
      <section className="card space-y-4">
        <CardTitle title="ตั้งค่ากลยุทธ์ปัจจัย" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SelectField label="กลยุทธ์" value={strategy} onChange={setStrategy} options={STRATEGIES} />
          <label className="block">
            <span className="label">ณ วันที่ (ว่าง = วันนี้)</span>
            <input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <SelectField
            label="ข้อมูลงบ ณ วันนั้น"
            value={pit}
            onChange={setPit}
            options={[
              { value: "strict", label: "เข้ม: งบที่เผยแพร่แล้วเท่านั้น" },
              { value: "illustrative_lookahead", label: "ภาพประกอบ (look-ahead)" },
            ]}
          />
          <SelectField label="วิธีให้น้ำหนัก" value={s.weighting} onChange={(v) => setS({ ...s, weighting: v })} options={[{ value: "equal", label: "เท่ากัน" }, { value: "score", label: "ตามคะแนน" }]} />
          <NumField label="จำนวนหุ้น (top N)" value={s.topN} onChange={(v) => setS({ ...s, topN: Math.max(1, Math.round(v ?? 10)) })} />
          <NumField label="Hold buffer (อันดับ)" value={s.holdBuffer} onChange={(v) => setS({ ...s, holdBuffer: Math.max(0, Math.round(v ?? 0)) })} hint="ใช้ใน backtest เพื่อลด turnover" />
          <NumField label="น้ำหนักสูงสุด/ตัว" pct value={s.maxWeight} onChange={(v) => setS({ ...s, maxWeight: v ?? 0.25 })} />
          <NumField label="สูงสุด/หมวด" pct nullable value={s.maxPerSector} onChange={(v) => setS({ ...s, maxPerSector: v })} />
        </div>
        {strategy === "multi_factor" && (
          <div className="grid gap-3 sm:grid-cols-4">
            {FACTOR_FAMILIES.map((f) => (
              <NumField key={f} label={`น้ำหนัก ${FAMILY_LABEL[f]}`} pct value={fw[f]} onChange={(v) => setS({ ...s, familyWeights: { ...fw, [f]: Math.min(1, Math.max(0, v ?? 0)) } })} />
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-4">
          <Toggle label="จัดอันดับภายในหมวด (sector-neutral)" checked={s.sectorNeutral} onChange={(v) => setS({ ...s, sectorNeutral: v })} />
          <Toggle label="Momentum ÷ ความผันผวน" checked={s.volScaledMomentum} onChange={(v) => setS({ ...s, volScaledMomentum: v })} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" onClick={run} disabled={pending || !symbols.length}>
            {pending ? "กำลังคำนวณ…" : "คัดกรองตามปัจจัย"}
          </button>
          <span className="text-xs text-muted">จักรวาล: {symbols.join(", ") || "–"} · ค่าตั้งต้นเป็นตัวอย่างที่แก้ได้</span>
        </div>
        {error && <p className="text-sm text-neg">{error}</p>}
      </section>

      {res && (
        <>
          <section className="card overflow-x-auto">
            <CardTitle
              title={`ผลคัดกรอง ${STRATEGIES.find((x) => x.value === res.strategyId)?.label} ณ ${res.asOf}`}
              explain={{
                data: compact({ กลยุทธ์: res.strategyId, เลือก: res.selected, น้ำหนัก: res.targetWeights, ครอบคลุมข้อมูล: res.factorDataCoverage, อันดับ: res.ranked.map((r) => ({ symbol: r.symbol, score: r.score, families: Object.fromEntries(FACTOR_FAMILIES.map((f) => [f, r.families[f].score])) })), เทียบเดี่ยว: res.standalone }),
                hint: "คะแนน = เปอร์เซ็นไทล์เทียบหุ้นอื่นในจักรวาล (0–1) เฉลี่ยในแต่ละกลุ่มปัจจัย แล้วถ่วงน้ำหนักตามที่ตั้ง; ข้อมูลที่ขาดไม่ถูกเติม",
              }}
            >
              <Badge className="ml-2 align-middle">{res.sourceStatus === "verified" ? "ข้อมูลครบ" : res.sourceStatus === "partial" ? "ข้อมูลบางส่วน" : "ข้อมูลไม่พอ"}</Badge>
            </CardTitle>
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {FACTOR_FAMILIES.map((f) => (
                <Badge key={f}>
                  {FAMILY_LABEL[f]}: {res.factorDataCoverage[f].available}/{res.factorDataCoverage[f].total}
                </Badge>
              ))}
            </div>
            {res.ranked.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>หุ้น</th>
                    <th className="min-w-32">คะแนนรวม</th>
                    {FACTOR_FAMILIES.map((f) => (
                      <th key={f} className="num">
                        {FAMILY_LABEL[f]}
                      </th>
                    ))}
                    <th className="num">น้ำหนักเป้า</th>
                  </tr>
                </thead>
                <tbody>
                  {res.ranked.map((r, i) => (
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
                          </div>
                        </td>
                        {FACTOR_FAMILIES.map((f) => (
                          <td key={f} className="num">
                            {r.families[f].score == null ? <span className="text-muted">–</span> : r.families[f].score!.toFixed(2)}
                          </td>
                        ))}
                        <td className="num font-medium">{res.targetWeights[r.symbol] ? fmtPct(res.targetWeights[r.symbol], 1) : "–"}</td>
                      </tr>
                      {open === r.symbol && (
                        <tr>
                          <td colSpan={8} className="bg-panel-2/50 whitespace-normal">
                            <div className="grid gap-1 py-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
                              {FACTOR_FAMILIES.flatMap((f) =>
                                r.families[f].subs.map((sub) => (
                                  <div key={`${f}.${sub.key}`} className="flex justify-between gap-2 rounded-md px-2 py-1" title={sub.note}>
                                    <span className="text-muted">{sub.label}</span>
                                    <span className="tabular-nums">
                                      {sub.value == null ? sub.status : PCT_KEYS.has(sub.key) ? fmtPct(sub.value, 1) : fmtNum(sub.value, 2)}
                                      {sub.rank != null && <span className="text-accent"> · {(sub.rank * 100).toFixed(0)}</span>}
                                    </span>
                                  </div>
                                )),
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted">ไม่มีหุ้นที่มีข้อมูลพอ</p>
            )}
            {res.standalone && (
              <p className="mt-3 text-xs text-muted">
                เทียบปัจจัยเดี่ยว: {Object.entries(res.standalone).map(([k, v]) => `${k} → ${v.selected.join(", ") || "–"}`).join(" · ")}
              </p>
            )}
            <ul className="mt-2 space-y-0.5 text-xs text-muted">
              {[...res.diagnostics, ...res.limitations].map((d) => (
                <li key={d}>• {d}</li>
              ))}
            </ul>
          </section>
          {res.excluded.length > 0 && (
            <section className="card overflow-x-auto">
              <CardTitle title="ข้อมูลไม่พอ / ไม่ถูกจัดอันดับ" explain={{ data: res.excluded }} />
              <table className="table">
                <tbody>
                  {res.excluded.map((e) => (
                    <tr key={e.symbol}>
                      <td className="font-medium">{e.symbol}</td>
                      <td>
                        <Badge>{e.code}</Badge>
                      </td>
                      <td className="text-xs whitespace-normal text-muted">{e.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {Object.keys(res.targetWeights).length > 0 && <RebalancePanel suggested={Object.entries(res.targetWeights).map(([symbol, weight]) => ({ symbol, weight }))} extraCash={0} sourceLabel="กลยุทธ์ปัจจัย" />}
        </>
      )}
    </div>
  );
}
