import { getMptAnalysis, getPerformance } from "@/server/services/portfolio";
import { FrontierChart, GrowthChart } from "@/components/charts";
import { Empty, PageHeader, Section } from "@/components/ui";
import { fmtPct, fmtRatio, signClass } from "@/lib/format";
import { DataQualityPanel, xirrNote, xirrText } from "@/components/DataQuality";

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
        <Section title="ผลตอบแทนและความเสี่ยง" className="min-w-0">
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
                <Row label="Downside deviation" value={fmtPct(perf.downsideDeviation)} formula="√(Σ min(0, rₜ − rf,ₜ)² / n) × √N" />
                <Row label="Max drawdown" value={fmtPct(perf.maxDrawdown)} formula="ลดลงสูงสุดจากจุดสูงสุดของดัชนี TWR" />
                <Row
                  label={`VaR 95% (1 งวด ≈ ${perf.varHorizonDays?.toFixed(1) ?? "–"} วัน)`}
                  value={fmtPct(perf.var95)}
                  formula={na(perf.var95, "ต้องมีอย่างน้อย 100 งวด") ?? "Historical — ควอนไทล์ 5% ของผลตอบแทนรายงวด"}
                />
                <Row label="Expected shortfall 95%" value={fmtPct(perf.cvar95)} formula={na(perf.cvar95, "ต้องมีอย่างน้อย 100 งวด") ?? "ค่าเฉลี่ยของ n·5% งวดที่แย่ที่สุด"} />
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Risk-adjusted & CAPM" className="min-w-0">
          <div className="overflow-x-auto">
            <table className="table">
              <tbody>
                <Row label="Sharpe ratio" value={fmtRatio(perf.sharpe)} formula={na(perf.sharpe, "ข้อมูลไม่พอ (ต้อง ≥ " + perf.dataQuality.minRequired + " งวด)") ?? "mean(rₜ − rf,ₜ) / σ(rₜ − rf,ₜ) × √N"} />
                <Row label="Sortino ratio" value={fmtRatio(perf.sortino)} formula="mean(excess) × N / downside deviation" />
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

      <Section title="ผลตอบแทนสะสม (TWR) เทียบดัชนี">
        <GrowthChart data={perf.growth} benchmark={b?.symbol} />
      </Section>

      <Section title="Modern Portfolio Theory — Efficient frontier">
        {!mpt.ok ? (
          <Empty>{mpt.reason}</Empty>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">
              ประมาณจากผลตอบแทนรายวัน (บาท) {mpt.observations} วัน ({mpt.from} → {mpt.to}) ของสินทรัพย์ที่ถืออยู่ · long-only, ลงทุนเต็มจำนวน
              {mpt.skipped.length > 0 && ` · ข้าม ${mpt.skipped.join(", ")} (ข้อมูลราคาหรือ USDTHB ไม่พอ)`}
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
                      <td className="num">{fmtPct(mpt.tangency.weights[i], 1)}</td>
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
                      <td className="num">{f(mpt.tangency)}</td>
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
        <Section title="Correlation matrix">
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
    </>
  );
}
