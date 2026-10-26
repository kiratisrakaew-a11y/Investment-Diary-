import { getMptAnalysis, getPerformance } from "@/server/services/portfolio";
import { FrontierChart, GrowthChart } from "@/components/charts";
import { Empty, PageHeader, Section } from "@/components/ui";
import { fmtPct, fmtRatio, signClass } from "@/lib/format";

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
        subtitle={perf.startDate ? `ช่วง ${perf.startDate} → ${perf.endDate} · ${perf.periods} วันทำการ · Risk-free ${fmtPct(perf.riskFreeRate)}` : "ยังไม่มีข้อมูล"}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="ผลตอบแทนและความเสี่ยง">
          <table className="table">
            <tbody>
              <Row label="TWR สะสม" value={fmtPct(perf.twrCumulative)} tone={signClass(perf.twrCumulative)} formula="Π(1 + rₜ) − 1, rₜ = Vₜ / (Vₜ₋₁ + CFₜ) − 1 — ตัดผลการฝาก/ถอน" />
              <Row label="TWR ต่อปี (Rp)" value={fmtPct(perf.twrAnnualized)} tone={signClass(perf.twrAnnualized)} formula="(1 + TWR)^(1/ปี) − 1" />
              <Row label="XIRR (Money-weighted)" value={fmtPct(perf.mwrXirr)} tone={signClass(perf.mwrXirr)} formula="r ที่ทำให้ Σ CFᵢ/(1+r)^tᵢ = 0" />
              <Row label="Risk-free rate (Rf)" value={fmtPct(perf.riskFreeRate)} formula="อัตราผลตอบแทนพันธบัตรรัฐบาลไทยระยะสั้น (ตั้งค่าได้)" />
              <Row label="Risk premium" value={fmtPct(perf.riskPremium)} tone={signClass(perf.riskPremium)} formula="Rp − Rf" />
              <Row label="Volatility (σ)" value={fmtPct(perf.volatility)} formula="σ(daily) × √252" />
              <Row label="Downside deviation" value={fmtPct(perf.downsideDeviation)} formula="√(Σ min(0, r − Rf/252)² / n) × √252" />
              <Row label="Max drawdown" value={fmtPct(perf.maxDrawdown)} formula="ลดลงสูงสุดจากจุดสูงสุด" />
              <Row label="VaR 95% (1 วัน)" value={fmtPct(perf.var95Daily)} formula="Historical — 5% ของวันที่แย่ที่สุด" />
              <Row label="CVaR / Expected shortfall" value={fmtPct(perf.cvar95Daily)} formula="ค่าเฉลี่ยของขาดทุนที่เกิน VaR" />
            </tbody>
          </table>
        </Section>

        <Section title="Risk-adjusted & CAPM">
          <table className="table">
            <tbody>
              <Row label="Sharpe ratio" value={fmtRatio(perf.sharpe)} formula="(Rp − Rf) / σp" />
              <Row label="Sortino ratio" value={fmtRatio(perf.sortino)} formula="(Rp − Rf) / downside deviation" />
              <Row label="Calmar ratio" value={fmtRatio(perf.calmar)} formula="Rp / Max drawdown" />
              {b ? (
                <>
                  <Row label={`ผลตอบแทนตลาด Rm (${b.symbol})`} value={fmtPct(b.annualized)} formula={`สะสม ${fmtPct(b.cumulative)} · σm ${fmtPct(b.volatility)}`} />
                  <Row label="Market risk premium" value={fmtPct(b.marketRiskPremium)} formula="Rm − Rf" />
                  <Row label="Beta (β)" value={fmtRatio(b.beta)} formula="Cov(Rp, Rm) / Var(Rm)" />
                  <Row label="Correlation (ρ)" value={fmtRatio(b.correlation)} formula="ความสัมพันธ์กับตลาด" />
                  <Row label="CAPM expected return" value={fmtPct(b.capmExpectedReturn)} formula="Rf + β(Rm − Rf)" />
                  <Row label="Jensen's alpha (α)" value={fmtPct(b.jensenAlpha)} tone={signClass(b.jensenAlpha)} formula="Rp − [Rf + β(Rm − Rf)]" />
                  <Row label="Treynor ratio" value={fmtRatio(b.treynor)} formula="(Rp − Rf) / β" />
                  <Row label="Tracking error" value={fmtPct(b.trackingError)} formula="σ(Rp − Rm)" />
                  <Row label="Information ratio" value={fmtRatio(b.informationRatio)} formula="(Rp − Rm) / Tracking error" />
                </>
              ) : (
                <tr>
                  <td colSpan={3} className="text-muted">ยังไม่มีข้อมูลดัชนีอ้างอิง — กด “ดึงราคาล่าสุด” ในหน้าสินทรัพย์</td>
                </tr>
              )}
            </tbody>
          </table>
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
              {mpt.skipped.length > 0 && ` · ข้าม ${mpt.skipped.join(", ")} (ข้อมูลราคาไม่พอ)`}
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
