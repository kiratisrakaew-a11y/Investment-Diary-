import Link from "next/link";
import { getAllocation, getPerformance, getPortfolioSummary, loadPortfolioData } from "@/server/services/portfolio";
import { listNotes } from "@/server/services/notes";
import { AllocationDonut, GrowthChart, ValueChart } from "@/components/charts";
import { AllocationTable } from "@/components/AllocationTable";
import { Card, EmptyState, ErrorState, KpiCard, PageHeader, Section } from "@/components/ui";
import { Tabs } from "@/components/ui-client";
import { EmptyIcon, IconChip } from "@/components/icons";
import { NoteCard } from "@/components/NoteCard";
import { ASSET_CLASS_LABEL, fmtPct, fmtRatio, fmtThb, signClass } from "@/lib/format";
import { Briefcase, Notebook } from "@phosphor-icons/react/ssr";
import { DataQualityPanel, xirrNote, xirrText } from "@/components/DataQuality";
import { compact, downsample } from "@/lib/explain-data";
import { BasisBenchmarkPicker, BasisSummary } from "@/components/BasisBenchmarkPicker";
import { listBenchmarks } from "@/server/services/benchmarks";
import { BENCHMARK_KIND_LABEL, isReturnBasis, PERF_BASIS_NOTE } from "@/lib/finance/price-basis";
import { BenchmarkError } from "@/lib/finance/benchmark-resolve";

type DashQuery = { basis?: string; bench?: string };

export default async function Dashboard({ searchParams }: { searchParams: Promise<DashQuery> }) {
  const q = await searchParams;
  // One load of prices / ledger / FX shared by the three calculations (was loaded three times).
  const data = await loadPortfolioData();
  const settings = data.settings;
  // PRICE_BASIS_BENCHMARK_SPEC F1: ?basis / ?bench override Settings (same values as the analytics page).
  const returnBasis = isReturnBasis(q.basis) ? q.basis : settings.defaultReturnBasis;
  const benchmark = q.bench?.trim() || settings.defaultBenchmark;
  const [summary, allocation, perfOrError, notes, benchmarks] = await Promise.all([
    getPortfolioSummary(undefined, data),
    getAllocation(undefined, data),
    getPerformance(undefined, data, { returnBasis, benchmark }).catch((e) => {
      if (e instanceof BenchmarkError) return e;
      throw e;
    }),
    listNotes({ limit: 4 }),
    listBenchmarks(),
  ]);
  const picker = (
    <Card className="space-y-2">
      <BasisBenchmarkPicker mode="query" value={{ basis: returnBasis, bench: benchmark }} benchmarks={benchmarks} note={PERF_BASIS_NOTE} />
      {perfOrError instanceof BenchmarkError ? (
        <ErrorState title="ใช้ดัชนีอ้างอิงนี้ไม่ได้" message={`${perfOrError.message} [${perfOrError.code}] — ${perfOrError.issue.suggestion}`} />
      ) : (
        <BasisSummary priceBasis={perfOrError.priceBasis} benchmark={perfOrError.benchmark} />
      )}
    </Card>
  );
  if (perfOrError instanceof BenchmarkError)
    return (
      <>
        <PageHeader title="ภาพรวมพอร์ต" />
        {picker}
      </>
    );
  const perf = perfOrError;

  if (summary.positions.length === 0 && summary.cashThb === 0) {
    return (
      <>
        <PageHeader title="ภาพรวมพอร์ต" />
        <EmptyState
          icon={<EmptyIcon icon={Briefcase} />}
          title="ยังไม่มีข้อมูลพอร์ต"
          description="เริ่มจากเพิ่มสินทรัพย์ แล้วบันทึกการซื้อ หรือให้ Claude / ChatGPT บันทึกให้ (ดูวิธีในหน้าตั้งค่า)"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link className="btn" href="/holdings">เพิ่มสินทรัพย์</Link>
              <Link className="btn-ghost" href="/transactions">บันทึกการซื้อ</Link>
              <Link className="btn-ghost" href="/settings">ตั้งค่า</Link>
            </div>
          }
        />
      </>
    );
  }

  const investedShare = summary.totalValueThb > 0 ? 1 - summary.cashThb / summary.totalValueThb : null;
  const pnlPct = summary.netContributedThb > 0 ? summary.totalPnlThb / summary.netContributedThb : null;
  const allocationData = allocation.rows.map((r) => ({ กลุ่ม: ASSET_CLASS_LABEL[r.assetClass], มูลค่าบาท: r.value, สัดส่วนจริงเปอร์เซ็นต์: r.actualPct, เป้าหมายเปอร์เซ็นต์: r.targetPct, ส่วนต่างจุดเปอร์เซ็นต์: r.driftPct, ซื้อขายเพื่อกลับเป้าบาท: r.rebalanceAmount }));
  const kpiData = compact({
    มูลค่าพอร์ตบาท: summary.totalValueThb,
    เงินสดบาท: summary.cashThb,
    ลงทุนสุทธิบาท: summary.netContributedThb,
    กำไรขาดทุนรวมบาท: summary.totalPnlThb,
    ช่วงข้อมูลวัน: perf.periodDays,
    TWR_สะสม: perf.cumulativeReturn,
    TWR_ต่อปี: perf.annualizedReturn,
    TWR_เทียบเท่าต่อปี_ประมาณการ: perf.displayReturnConvention === "cumulative" ? perf.annualizedEquivalent : undefined,
    XIRR_ต่อปี: perf.xirr.rate,
    XIRR_สถานะ: perf.xirr.status,
    Sharpe: perf.sharpe,
    ความผันผวนต่อปี: perf.volatility,
    MaxDrawdown: perf.maxDrawdown,
    RiskFree: perf.riskFreeRate,
  });

  const twrAnnual = perf.displayReturnConvention === "annualized";
  const bench = perf.benchmark;
  return (
    <div className="space-y-6">
      <PageHeader
        title="ภาพรวมพอร์ต"
        subtitle={perf.startDate ? `ตั้งแต่ ${perf.startDate} · Rf ${settings.riskFreeRate}%${settings.rfSource ? ` (${settings.rfSource})` : " (ค่าตัวอย่าง)"} · เทียบ ${bench?.symbol ?? settings.benchmarkSymbol}` : undefined}
        explain={{ topic: "ตัวเลขสรุปพอร์ต", data: kpiData, hint: "TWR วัดฝีมือการลงทุนตัดผลฝาก/ถอน; XIRR คือผลตอบแทนจริงของเงินที่รวมจังหวะเติมเงิน; Sharpe = ผลตอบแทนส่วนเกินต่อความผันผวน" }}
        action={<Link href="/transactions" className="btn">บันทึกรายการ</Link>}
      />
      {picker}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard
          label="มูลค่าพอร์ต"
          value={fmtThb(summary.totalValueThb)}
          note={`เงินสด ${fmtThb(summary.cashThb)}${investedShare != null ? ` · ลงทุนอยู่ ${fmtPct(investedShare, 0)}` : ""}`}
          icon={<IconChip category="stock" icon={Briefcase} label="มูลค่าพอร์ต" />}
        />
        <KpiCard
          label="กำไร/ขาดทุนรวม"
          value={fmtThb(summary.totalPnlThb)}
          valueClassName={signClass(summary.totalPnlThb)}
          change={pnlPct}
          changeLabel="เทียบเงินลงทุน"
          note={`ลงทุนสุทธิ ${fmtThb(summary.netContributedThb)}`}
          hint="เปอร์เซ็นต์ = กำไร/ขาดทุนเทียบกับเงินลงทุนสุทธิ"
          icon={<IconChip category="valuation" label="กำไรขาดทุน" />}
        />
        <KpiCard
          label={twrAnnual ? "TWR ต่อปี" : `TWR สะสม (${perf.periodDays} วัน)`}
          value={fmtPct(twrAnnual ? perf.annualizedReturn : perf.cumulativeReturn)}
          valueClassName={signClass(twrAnnual ? perf.annualizedReturn : perf.cumulativeReturn)}
          note={twrAnnual ? `สะสม ${fmtPct(perf.cumulativeReturn)}` : `เทียบเท่าต่อปี (ประมาณการ) ${fmtPct(perf.annualizedEquivalent)}`}
          hint={twrAnnual ? "Time-weighted return: วัดฝีมือการลงทุน ตัดผลของการฝาก/ถอนเงิน" : "ช่วงข้อมูลสั้นกว่า 1 ปี จึงแสดงผลตอบแทนสะสมเป็นหลัก — ค่าเทียบเท่าต่อปีเป็นการขยายผล (extrapolation) ไม่ใช่ผลตอบแทนจริงต่อปี"}
          icon={<IconChip category="metrics" label="TWR" />}
        />
        <KpiCard
          label="XIRR (MWR) ต่อปี"
          value={xirrText(perf.xirr)}
          valueClassName={signClass(perf.xirr.rate)}
          note={xirrNote(perf.xirr)}
          hint="Money-weighted return: ผลตอบแทนจริงของเงินคุณ รวมจังหวะการเติมเงิน"
          icon={<IconChip category="metrics" label="XIRR" />}
        />
      </div>

      <DataQualityPanel issues={summary.issues} warnings={perf.dataQuality.warnings} reconciliation={summary.reconciliation} />

      <Section
        title="มูลค่าพอร์ต vs เงินลงทุน"
        subtitle="เส้นมูลค่าพอร์ตเทียบเงินที่ใส่เข้าไปสุทธิ — ระยะห่างระหว่างสองเส้น = กำไร/ขาดทุนสะสม"
        explain={{ data: compact({ จุดข้อมูล: downsample(perf.valueSeries, 20), มูลค่าล่าสุด: summary.totalValueThb, ลงทุนสุทธิ: summary.netContributedThb }), hint: "ระยะห่างระหว่างเส้นมูลค่ากับเส้นเงินลงทุน = กำไร/ขาดทุนสะสม" }}
      >
        <ValueChart data={perf.valueSeries} />
      </Section>

      <Section
        title="สัดส่วนจริง vs เป้าหมาย"
        subtitle="ส่วนต่างจากเป้าและจำนวนเงินที่ต้องซื้อ/ขายเพื่อกลับเป้า"
        explain={{ data: compact(allocationData), hint: "ค่าบวกในซื้อขายเพื่อกลับเป้า = ควรซื้อเพิ่ม ค่าลบ = ขายออก (เพื่อกลับสู่สัดส่วนเป้าหมาย)" }}
        action={<Link href="/settings" className="text-xs text-primary">ตั้งเป้า</Link>}
      >
        <AllocationTable rows={allocation.rows} />
      </Section>

      <Card>
        <Tabs
          ariaLabel="รายละเอียดเชิงลึก"
          tabs={[
            {
              id: "allocation",
              label: "สัดส่วนตามประเภท",
              content: (
                <div className="mx-auto max-w-md">
                  <AllocationDonut rows={allocation.rows} />
                </div>
              ),
            },
            {
              id: "benchmark",
              label: "เทียบดัชนีอ้างอิง",
              content: (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-xs text-text-muted">การเติบโตของเงิน 1 บาท เทียบกับดัชนีอ้างอิง</p>
                    <Link href="/analytics" className="text-xs text-primary">วิเคราะห์เพิ่ม →</Link>
                  </div>
                  <GrowthChart data={perf.growth} benchmark={bench ? `${bench.symbol} (${BENCHMARK_KIND_LABEL[bench.kind]})` : undefined} />
                  {bench && (
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div>
                        <div className="text-text-muted">Beta (OLS)</div>
                        <div className="text-sm font-medium tabular-nums">{fmtRatio(bench.regressionBeta)}</div>
                      </div>
                      <div>
                        <div className="text-text-muted">Alpha ต่อปี (OLS)</div>
                        <div className={`text-sm font-medium tabular-nums ${signClass(bench.regressionAlphaAnnual)}`}>
                          {fmtPct(bench.regressionAlphaAnnual)}
                          {bench.alphaStdError != null && <span className="text-text-muted"> ±{fmtPct(bench.alphaStdError)}</span>}
                        </div>
                      </div>
                      <div>
                        <div className="text-text-muted">Excess return (Rp − Rf)</div>
                        <div className="text-sm font-medium tabular-nums">{fmtPct(perf.realizedExcessReturn)}</div>
                      </div>
                    </div>
                  )}
                  {bench?.kind === "price_index" && <p className="text-xs text-text-muted">เลือกดัชนี “อัตโนมัติ” ที่หัวหน้าเพื่อเทียบกับดัชนีผลตอบแทนรวม (ต้องนำเข้า SET TRI ก่อน)</p>}
                </div>
              ),
            },
            {
              id: "risk",
              label: "ความเสี่ยง",
              content: (
                <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                  <KpiCard label="Sharpe ratio" value={fmtRatio(perf.sharpe)} note={perf.sharpe == null ? `ข้อมูลไม่พอ (${perf.dataQuality.observations}/${perf.dataQuality.minRequired} จุด)` : "ผลตอบแทนส่วนเกินต่อความผันผวน"} hint="mean(Rp − Rf) / σ(Rp − Rf) × √N — ใช้ผลตอบแทนส่วนเกินรายงวด, N = จำนวนงวดต่อปีจากข้อมูลจริง" />
                  <KpiCard label="ความผันผวนต่อปี (σ)" value={fmtPct(perf.volatility, 1)} />
                  <KpiCard label="Max drawdown" value={fmtPct(perf.maxDrawdown, 1)} valueClassName={signClass(perf.maxDrawdown)} />
                  <KpiCard label="Risk-free" value={fmtPct(perf.riskFreeRate, 1)} note={settings.rfSource ?? "ค่าตัวอย่าง"} />
                </div>
              ),
            },
            {
              id: "notes",
              label: "บันทึกล่าสุด",
              badge: notes.length || undefined,
              content: (
                <div className="space-y-3">
                  <div className="text-right">
                    <Link href="/journal" className="text-xs text-primary">ทั้งหมด →</Link>
                  </div>
                  {notes.length ? (
                    notes.map((n) => <NoteCard key={n.id} note={n} compact />)
                  ) : (
                    <EmptyState icon={<EmptyIcon icon={Notebook} />} title="ยังไม่มีบันทึก" description="จดไอเดีย thesis หรือบทเรียนไว้ที่สมุดบันทึก" action={<Link href="/journal" className="btn-ghost">ไปที่บันทึก</Link>} />
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
