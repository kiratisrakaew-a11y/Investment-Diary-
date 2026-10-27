import { getMptAnalysis, getPerformance } from "@/server/services/portfolio";
import { FrontierChart, GrowthChart } from "@/components/charts";
import { Empty, PageHeader, Section } from "@/components/ui";
import { fmtPct, fmtRatio, signClass } from "@/lib/format";
import { compact, downsample } from "@/lib/explain-data";
import { DataQualityPanel, xirrNote, xirrText } from "@/components/DataQuality";
import { StressPanel } from "@/components/StressPanel";

const TIMING_LABEL = {
  start_of_day: "เงินเข้า/ออกต้นวัน: rₜ = Vₜ / (Vₜ₋₁ + CFₜ) − 1",
  end_of_day: "เงินเข้า/ออกสิ้นวัน: rₜ = (Vₜ − CFₜ) / Vₜ₋₁ − 1",
  modified_dietz: "Modified Dietz: rₜ = (Vₜ − Vₜ₋₁ − CFₜ) / (Vₜ₋₁ + ½CFₜ)",
} as const;

const na = (v: number | null, reason: string) => (v == null ? reason : undefined);

function Row({ label, value, formula, tone }: { label: string; value: string; formula: string; tone?: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td className={`num font-medium ${tone ?? ""}`}>{value}</td>
      <td className="text-xs whitespace-normal text-muted">{formula}</td>
    </tr>
  );
}

function corrColor(c: number) {
  // Diverging: blue (−1) ← neutral gray (0) → orange (+1)
  const a = Math.min(1, Math.abs(c));
  return c >= 0 ? `color-mix(in oklab, var(--series-2) ${a * 70}%, var(--panel))` : `color-mix(in oklab, var(--series-1) ${a * 70}%, var(--panel))`;
}

export default async function AnalyticsPage() {
  const [perf, mpt] = await Promise.all([getPerformance(), getMptAnalysis()]);
  const navNow = perf.valueSeries[perf.valueSeries.length - 1]?.value ?? 0;

  // Values sent to the "อธิบาย" buttons — the same figures each section renders.
  const returnRisk = compact({
    ช่วงข้อมูล: `${perf.startDate} → ${perf.endDate}`,
    จำนวนงวด: perf.periods,
    TWR_สะสม: perf.cumulativeReturn,
    TWR_ต่อปี: perf.annualizedReturn,
    ผลตอบแทนเฉลี่ยต่อปี_arithmetic: perf.arithmeticAnnualReturn,
    XIRR: perf.xirr.rate,
    RiskFree: perf.riskFreeRate,
    ExcessReturnต่อปี: perf.realizedExcessReturn,
    ความผันผวนต่อปี: perf.volatility,
    DownsideDeviation: perf.downsideDeviation,
    MaxDrawdown: perf.maxDrawdown,
    VaR_ES: perf.varTable.map((v) => ({ ความเชื่อมั่น: v.confidence, VaR_1งวด: v.var, ES_1งวด: v.es, จำนวนข้อมูล: v.observations, เชื่อถือได้: v.reliable, VaR_10วัน_ประมาณ: v.horizon.tenPeriodScaled.var })),
    BacktestVaR: perf.varBacktest.map((b) => ("unavailable" in b ? { ความเชื่อมั่น: b.confidence, ไม่มีผล: b.unavailable } : { ความเชื่อมั่น: b.confidence, วันที่ขาดทุนเกินVaR: b.exceptions, ที่คาดไว้: b.expected, Kupiec_p: b.kupiec.pValue, Christoffersen_p: "pValue" in b.christoffersen ? b.christoffersen.pValue : null })),
  });
  const capm = compact({ Sharpe: perf.sharpe, Sortino: perf.sortino, Calmar: perf.calmar, benchmark: perf.benchmark ? { ...perf.benchmark, warnings: undefined } : null });
  const b = perf.benchmark;

  return (
    <>
      <PageHeader
        title="วิเคราะห์ผลการดำเนินงาน"
        subtitle={
          perf.startDate
            ? `ช่วง ${perf.startDate} → ${perf.endDate} (${perf.periodDays} วัน) · ${perf.periods} งวด · N ≈ ${perf.observationsPerYear?.toFixed(1) ?? "–"} งวด/ปี · Risk-free ${fmtPct(perf.riskFreeRate)}`
            : "ยังไม่มีข้อมูล"
        }
      />

      <p className="text-xs text-muted">
        สมมติฐานการคำนวณ: TWR — {TIMING_LABEL[perf.flowTiming]} · XIRR ใช้ ACT/365 · ความผันผวน/Sharpe ใช้ผลตอบแทนส่วนเกินรายงวด × √N โดย N มาจากข้อมูลจริง (ไม่ใช่ 252 ตายตัว) ·
        Rf ต่องวด = (1 + Rf)^(Δวัน/365) − 1{b && ` · ดัชนีอ้างอิง ${b.symbol} = ${b.kind === "price_index" ? "ดัชนีราคา (ไม่รวมปันผล)" : "ดัชนีผลตอบแทนรวม"}`}
      </p>

      <DataQualityPanel warnings={[...perf.dataQuality.warnings, ...(b?.warnings ?? [])]} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="ผลตอบแทนและความเสี่ยง" className="min-w-0" explain={{ data: returnRisk, hint: "VaR = ขาดทุนที่ไม่ควรเกินในวันปกติตามระดับความเชื่อมั่น; ES = ขาดทุนเฉลี่ยในวันที่แย่กว่า VaR; Kupiec p < 0.05 แปลว่า VaR พลาดบ่อยหรือน้อยผิดปกติ" }}>
          <div className="overflow-x-auto">
            <table className="table">
              <tbody>
                <Row label={`TWR สะสม (${perf.periodDays} วัน)`} value={fmtPct(perf.cumulativeReturn)} tone={signClass(perf.cumulativeReturn)} formula="Π(1 + rₜ) − 1 — ตัดผลการฝาก/ถอน" />
                <Row
                  label="TWR ต่อปี (Rp, geometric)"
                  value={perf.annualizedReturn != null ? fmtPct(perf.annualizedReturn) : `– (เทียบเท่า ${fmtPct(perf.annualizedEquivalent)})`}
                  tone={signClass(perf.annualizedReturn)}
                  formula={perf.annualizationApplicable ? "(1 + TWR)^(365/วัน) − 1" : "ช่วงข้อมูล < 1 ปี: ไม่รายงานเป็นอัตราต่อปี; ค่าในวงเล็บเป็นการขยายผล (extrapolated)"}
                />
                <Row label="ผลตอบแทนเฉลี่ยต่อปี (arithmetic)" value={fmtPct(perf.arithmeticAnnualReturn)} formula="mean(rₜ) × N — ใช้คู่กับ σ; ต่างจาก geometric" />
                <Row label="XIRR (Money-weighted)" value={xirrText(perf.xirr)} tone={signClass(perf.xirr.rate)} formula={`r ที่ทำให้ Σ CFᵢ/(1+r)^(dᵢ/365) = 0 · ${xirrNote(perf.xirr)}`} />
                <Row label="Risk-free rate (Rf)" value={fmtPct(perf.riskFreeRate)} formula="ตั้งค่าเอง (ค่าเริ่มต้นเป็นตัวอย่าง ไม่ใช่ข้อมูลตลาด)" />
                <Row label="Excess return ต่อปี" value={fmtPct(perf.realizedExcessReturn)} tone={signClass(perf.realizedExcessReturn)} formula="mean(rₜ − rf,ₜ) × N" />
                <Row label="Volatility (σ)" value={fmtPct(perf.volatility)} formula="σ(rₜ) × √N" />
                <Row label="Downside deviation" value={fmtPct(perf.downsideDeviation)} formula={`√(Σ min(0, rₜ − MARₜ)² / n) × √N · MAR = ${perf.sortinoMarBasis === "risk_free" ? "Rf" : "ตั้งเอง"} ${fmtPct(perf.sortinoMar)} ต่อปี`} />
                <Row label="Max drawdown" value={fmtPct(perf.maxDrawdown)} formula="ลดลงสูงสุดจากจุดสูงสุดของดัชนี TWR" />
                <Row
                  label={`VaR 95% (1 งวด ≈ ${perf.varHorizonDays?.toFixed(1) ?? "–"} วัน)`}
                  value={fmtPct(perf.var95)}
                  formula={na(perf.var95, "ต้องมีอย่างน้อย 100 งวด") ?? "Historical — ควอนไทล์ 5% ของผลตอบแทนรายงวด"}
                />
                <Row label="Expected shortfall 95%" value={fmtPct(perf.cvar95)} formula={na(perf.cvar95, "ต้องมีอย่างน้อย 100 งวด") ?? "ค่าเฉลี่ยของ n·5% งวดที่แย่ที่สุด"} />
                {perf.varTable
                  .filter((v) => v.confidence === 0.99)
                  .map((v) => (
                    <Row
                      key="v99"
                      label="VaR / ES 99% (1 งวด)"
                      value={v.var != null ? `${fmtPct(v.var)} / ${fmtPct(v.es)}` : "–"}
                      formula={
                        v.var == null
                          ? `ต้องมีอย่างน้อย ${v.minRequired} งวด (มี ${v.observations})`
                          : `Historical · ${v.observations} งวด ≈ ${v.tailObservations.toFixed(1)} จุดในหาง${v.reliable ? "" : " — น้อย ความน่าเชื่อถือต่ำ (ต้อง ≥ 500)"} · √10 ≈ ${fmtPct(v.horizon.tenPeriodScaled.var)} (ประมาณการ)`
                      }
                    />
                  ))}
                {perf.varBacktest.map((b) => (
                  <Row
                    key={`bt${b.confidence}`}
                    label={`Backtest VaR ${(b.confidence * 100).toFixed(0)}% (rolling 250)`}
                    value={"unavailable" in b ? "–" : `${b.exceptions} / คาด ${b.expected.toFixed(1)}`}
                    formula={
                      "unavailable" in b
                        ? b.unavailable
                        : `Kupiec p = ${b.kupiec.pValue.toFixed(3)}${b.kupiec.reject5pct ? " (ปฏิเสธที่ 5%)" : ""} · ${"unavailable" in b.christoffersen ? `Christoffersen: ${b.christoffersen.unavailable}` : `Christoffersen p = ${b.christoffersen.pValue.toFixed(3)}`} · ${b.evaluated} งวดทดสอบ`
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium text-accent">VaR / ES ตามช่วงเวลาลงทุน (ผลตอบแทนทบต้นจริง)</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>ช่วงเวลา</th>
                    <th className="text-right">VaR 95%</th>
                    <th className="text-right">ES 95%</th>
                    <th className="text-right">VaR 99%</th>
                    <th className="text-right">≈ บาท (VaR 95%)</th>
                    <th>วิธี / ข้อจำกัด</th>
                  </tr>
                </thead>
                <tbody>
                  {perf.varHorizons.map((h) => {
                    const pick = h.nonOverlapping.var95 != null ? h.nonOverlapping : h.overlapping.var95 != null ? h.overlapping : null;
                    const kind = pick === h.nonOverlapping ? `ช่วงไม่ทับกัน ${h.nonOverlapping.windows} ช่วง` : pick ? `ช่วงทับกัน ${h.overlapping.windows} ช่วง` : "";
                    return (
                      <tr key={h.key}>
                        <td>
                          {h.label}
                          {Number.isFinite(h.periods) && <span className="block text-[11px] text-muted">{h.periods} งวด{h.calendarDays != null ? ` ≈ ${Math.round(h.calendarDays)} วัน` : ""}</span>}
                        </td>
                        <td className="num">{fmtPct(pick?.var95 ?? null)}</td>
                        <td className="num">{fmtPct(pick?.es95 ?? null)}</td>
                        <td className="num">{fmtPct(pick?.var99 ?? null)}</td>
                        <td className="num">{pick?.var95 != null && navNow > 0 ? Math.round(pick.var95 * navNow).toLocaleString() : "–"}</td>
                        <td className="whitespace-normal text-[11px] text-muted">
                          {h.unavailable ?? `${kind}${h.notes.length ? ` · ${h.notes.join(" · ")}` : ""}`}
                          {h.periods > 1 && h.sqrtScaledVar95 != null && ` · เทียบ √h (สมมติอิสระกัน): ${fmtPct(h.sqrtScaledVar95)}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-muted">
              R_H = Π(1 + rₜ) − 1 จากข้อมูลจริง — สถานะซื้อที่ไม่กู้ยืมขาดทุนไม่เกิน 100% · ไม่แสดงช่วงที่ข้อมูลไม่พอ (ไม่ขยายด้วย √h) · บาท = VaR × NAV ปัจจุบัน
            </p>
          </details>
        </Section>

        <Section title="Risk-adjusted & CAPM" className="min-w-0" explain={{ data: capm, hint: "Sharpe/Sortino/Calmar = ผลตอบแทนต่อหน่วยความเสี่ยง; Beta/Alpha จาก regression เทียบดัชนี; Treynor, Information ratio, Tracking error" }}>
          <div className="overflow-x-auto">
            <table className="table">
              <tbody>
                <Row label="Sharpe ratio" value={fmtRatio(perf.sharpe)} formula={na(perf.sharpe, "ข้อมูลไม่พอ (ต้อง ≥ " + perf.dataQuality.minRequired + " งวด)") ?? "mean(rₜ − rf,ₜ) / σ(rₜ − rf,ₜ) × √N"} />
                <Row label="Sortino ratio" value={fmtRatio(perf.sortino)} formula={`mean(rₜ − MARₜ) × N / downside deviation · MAR ${perf.sortinoMarBasis === "risk_free" ? "= Rf (เปลี่ยนได้ในหน้าตั้งค่า)" : "ตั้งเอง"} ${fmtPct(perf.sortinoMar)}`} />
                <Row label="Calmar ratio" value={fmtRatio(perf.calmar)} formula={na(perf.calmar, "ต้องมีข้อมูล ≥ 1 ปี") ?? "Rp (geometric ต่อปี) / Max drawdown"} />
                {b ? (
                  <>
                    <Row
                      label={`ตลาด Rm (${b.symbol})`}
                      value={b.annualized != null ? fmtPct(b.annualized) : `สะสม ${fmtPct(b.cumulative)}`}
                      formula={`${b.observations} งวดที่ดัชนีมีราคาจริง · σm ${fmtPct(b.volatility)}`}
                    />
                    <Row label="Market excess return (realized)" value={fmtPct(b.realizedMarketExcessReturn)} formula="ผลตอบแทนส่วนเกินของตลาดที่เกิดขึ้นจริงในช่วงนี้ — ไม่ใช่ ERP คาดการณ์" />
                    <Row
                      label="Beta (β, OLS)"
                      value={b.regressionBeta != null ? `${fmtRatio(b.regressionBeta)} ± ${fmtRatio(b.betaStdError)}` : "–"}
                      formula={`(rp − rf) = α + β(rm − rf) + ε · R² ${fmtRatio(b.rSquared)}`}
                    />
                    <Row label="Correlation (ρ)" value={fmtRatio(b.correlation)} formula="ความสัมพันธ์กับตลาด" />
                    <Row
                      label="Alpha ต่อปี (OLS)"
                      value={b.regressionAlphaAnnual != null ? `${fmtPct(b.regressionAlphaAnnual)} ± ${fmtPct(b.alphaStdError)}` : "–"}
                      tone={signClass(b.regressionAlphaAnnual)}
                      formula="α รายงวด × N ± standard error — |α| < 2·SE ถือว่าไม่ต่างจากศูนย์อย่างมีนัยสำคัญ"
                    />
                    <Row label="CAPM expected return (ประมาณ)" value={fmtPct(b.capmExpectedReturn)} formula="Rf + β(Rm − Rf) บนอัตราต่อปี" />
                    <Row label="Jensen's alpha (ประมาณ)" value={fmtPct(b.jensenAlphaApprox)} tone={signClass(b.jensenAlphaApprox)} formula="Rp − [Rf + β(Rm − Rf)] บนอัตราต่อปี — ใช้ค่า OLS ด้านบนเป็นหลัก" />
                    <Row label="Treynor ratio" value={fmtRatio(b.treynor)} formula="(Rp − Rf) / β — ไม่แสดงเมื่อ β ≤ 0" />
                    <Row label="Tracking error" value={fmtPct(b.trackingError)} formula="σ(rp − rm) × √N" />
                    <Row label="Information ratio" value={fmtRatio(b.informationRatio)} formula="mean(rp − rm) × N / Tracking error" />
                  </>
                ) : (
                  <tr>
                    <td colSpan={3} className="text-muted">ยังไม่มีข้อมูลดัชนีอ้างอิง — กด “ดึงราคาล่าสุด” ในหน้าสินทรัพย์</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <Section title="ผลตอบแทนสะสม (TWR) เทียบดัชนี" explain={{ data: compact({ ดัชนี: perf.benchmark?.symbol, การเติบโตของเงิน1บาท: downsample(perf.growth, 16) }) }}>
        <GrowthChart data={perf.growth} benchmark={b?.symbol} />
      </Section>

      <Section
        title="Modern Portfolio Theory — Efficient frontier"
        explain={
          mpt.ok
            ? {
                data: compact({
                  สินทรัพย์: mpt.assets.map((a, i) => ({ ...a, น้ำหนักปัจจุบัน: mpt.current.weights[i], น้ำหนักMinVariance: mpt.minVariance.weights[i], น้ำหนักMaxSharpe: mpt.tangency?.weights[i] })),
                  พอร์ตปัจจุบัน: { ...mpt.current, weights: undefined },
                  MinVariance: { ...mpt.minVariance, weights: undefined },
                  MaxSharpe: mpt.tangency ? { ...mpt.tangency, weights: undefined } : null,
                  ช่วงข้อมูล: `${mpt.from} → ${mpt.to}`,
                }),
                hint: "Efficient frontier = พอร์ตที่ให้ผลตอบแทนคาดหวังสูงสุดในแต่ละระดับความเสี่ยง; ค่าคาดหวังประมาณจากข้อมูลในอดีต",
              }
            : undefined
        }
      >
        {!mpt.ok ? (
          <Empty>{mpt.reason}</Empty>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">
              ประมาณจากผลตอบแทนด้านราคา (บาท, ไม่รวมปันผล — หน้าจัดพอร์ตเลือกแบบผลตอบแทนรวมได้) {mpt.observations} วันที่ทุกสินทรัพย์มีราคา ({mpt.from} → {mpt.to}, ≈ {mpt.periodsPerYear.toFixed(0)} งวด/ปี) ของสินทรัพย์ที่ถืออยู่ · long-only, ลงทุนเต็มจำนวน
              {mpt.covarianceWarnings.map((w) => ` · ⚠️ ${w}`)}
              {mpt.skipped.length > 0 && ` · ข้าม ${mpt.skipped.join(", ")} (ข้อมูลราคาหรือ USDTHB ไม่พอ)`}
              {mpt.warnings.map((w) => ` · ⚠️ ${w}`)}
            </p>
            <FrontierChart
              cloud={mpt.cloud}
              frontier={mpt.frontier}
              assets={mpt.assets}
              current={mpt.current}
              tangency={mpt.tangency}
              minVariance={mpt.minVariance}
              cml={mpt.cml}
            />
            <div className="mt-4 overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>สินทรัพย์</th>
                    <th className="num">E[R] ต่อปี</th>
                    <th className="num">σ ต่อปี</th>
                    <th className="num">น้ำหนักปัจจุบัน</th>
                    <th className="num">Min variance</th>
                    <th className="num">Max Sharpe</th>
                  </tr>
                </thead>
                <tbody>
                  {mpt.assets.map((a, i) => (
                    <tr key={a.symbol}>
                      <td className="font-medium">{a.symbol}</td>
                      <td className="num">{fmtPct(a.expectedReturn, 1)}</td>
                      <td className="num">{fmtPct(a.volatility, 1)}</td>
                      <td className="num">{fmtPct(mpt.current.weights[i], 1)}</td>
                      <td className="num">{fmtPct(mpt.minVariance.weights[i], 1)}</td>
                      <td className="num">{mpt.tangency ? fmtPct(mpt.tangency.weights[i], 1) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {(
                    [
                      ["E[R] พอร์ต", (p: typeof mpt.current) => fmtPct(p.expectedReturn, 1)],
                      ["σ พอร์ต", (p: typeof mpt.current) => fmtPct(p.volatility, 1)],
                      ["Sharpe", (p: typeof mpt.current) => fmtRatio(p.sharpe)],
                    ] as const
                  ).map(([label, f]) => (
                    <tr key={label} className="font-medium">
                      <td colSpan={3}>{label}</td>
                      <td className="num">{f(mpt.current)}</td>
                      <td className="num">{f(mpt.minVariance)}</td>
                      <td className="num">{mpt.tangency ? f(mpt.tangency) : "–"}</td>
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted">
              ⚠️ ค่าคาดหวังจากข้อมูลในอดีตมีความคลาดเคลื่อนสูง (estimation error) — ใช้เป็นแนวทางประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุน
            </p>
          </>
        )}
      </Section>

      {mpt.ok && (
        <Section title="Correlation matrix" explain={{ data: compact({ symbols: mpt.symbols, correlation: mpt.correlation }, 3), hint: "ค่าใกล้ 1 = ขึ้นลงพร้อมกัน, ใกล้ 0 = ไม่สัมพันธ์, ติดลบ = สวนทาง — ยิ่งต่ำยิ่งช่วยกระจายความเสี่ยง" }}>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th />
                  {mpt.symbols.map((s) => (
                    <th key={s} className="px-2 py-1 font-medium text-muted">{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mpt.correlation.map((row, i) => (
                  <tr key={i}>
                    <th className="pr-2 text-right font-medium text-muted">{mpt.symbols[i]}</th>
                    {row.map((c, j) => (
                      <td key={j} className="h-10 w-16 border-2 border-panel text-center tabular-nums" style={{ background: corrColor(c) }} title={`${mpt.symbols[i]} × ${mpt.symbols[j]}: ${c.toFixed(3)}`}>
                        {c.toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {mpt.ok && (
        <Section title="ส่วนร่วมความเสี่ยง (Risk contribution)" explain={{ data: compact({ ...mpt.risk, componentES95: mpt.risk.componentES95 }), hint: "เทียบ % น้ำหนักกับ % ของความเสี่ยงที่แต่ละตัวสร้าง — ตัวที่สร้างความเสี่ยงเกินน้ำหนักมาก ๆ ทำให้พอร์ตกระจุก" }}>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>สินทรัพย์</th>
                  <th className="num">น้ำหนัก</th>
                  <th className="num">MCTR</th>
                  <th className="num">ส่วนร่วม σ</th>
                  <th className="num">% ของความเสี่ยง</th>
                  <th className="num">Component ES 95% (รายวัน)</th>
                </tr>
              </thead>
              <tbody>
                {mpt.risk.assets.map((a, i) => (
                  <tr key={a.symbol}>
                    <td className="font-medium">{a.symbol}</td>
                    <td className="num">{fmtPct(a.weight, 1)}</td>
                    <td className="num">{fmtPct(a.mctr, 1)}</td>
                    <td className="num">{fmtPct(a.contribution, 2)}</td>
                    <td className={`num ${a.share > a.weight + 0.05 ? "text-neg" : ""}`}>{fmtPct(a.share, 1)}</td>
                    <td className="num">{mpt.risk.componentES95 ? fmtPct(mpt.risk.componentES95.assets[i].contribution, 2) : "–"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-medium">
                  <td>รวม</td>
                  <td />
                  <td />
                  <td className="num">{fmtPct(mpt.risk.volatility, 2)}</td>
                  <td className="num">100%</td>
                  <td className="num">{mpt.risk.componentES95 ? fmtPct(mpt.risk.componentES95.expectedShortfall, 2) : "ต้องมี ≥ 100 วัน"}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            MCTR = (Σw)ᵢ / σ · ส่วนร่วม = w × MCTR (รวมเท่ากับ σ พอร์ต) · กระจุกตัว: HHI {mpt.risk.concentration.hhi.toFixed(3)} → เทียบเท่า {mpt.risk.concentration.effectiveN.toFixed(1)} ตัว (น้ำหนัก),{" "}
            {mpt.risk.concentration.effectiveRiskN.toFixed(1)} ตัว (ความเสี่ยง) · ใหญ่สุด {fmtPct(mpt.risk.concentration.maxWeight, 1)} · 3 อันดับแรก {fmtPct(mpt.risk.concentration.top3, 1)} · สีแดง = ความเสี่ยงเกินน้ำหนักมากกว่า 5 จุด
          </p>
        </Section>
      )}

      <Section title="Stress test">
        <StressPanel />
      </Section>
    </>
  );
}
