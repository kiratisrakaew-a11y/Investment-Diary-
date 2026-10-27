import Link from "next/link";
import { getAllocation, getPerformance, getPortfolioSummary } from "@/server/services/portfolio";
import { listNotes } from "@/server/services/notes";
import { getSettings } from "@/server/services/settings";
import { AllocationDonut, GrowthChart, ValueChart } from "@/components/charts";
import { AllocationTable } from "@/components/AllocationTable";
import { Empty, PageHeader, Section, Stat } from "@/components/ui";
import { NoteCard } from "@/components/NoteCard";
import { ASSET_CLASS_LABEL, fmtPct, fmtRatio, fmtThb, signClass } from "@/lib/format";
import { DataQualityPanel, xirrNote, xirrText } from "@/components/DataQuality";
import { compact, downsample } from "@/lib/explain-data";

export default async function Dashboard() {
  const [summary, allocation, perf, notes, settings] = await Promise.all([
    getPortfolioSummary(),
    getAllocation(),
    getPerformance(),
    listNotes({ limit: 4 }),
    getSettings(),
  ]);

  if (summary.positions.length === 0 && summary.cashThb === 0) {
    return (
      <>
        <PageHeader title="ภาพรวมพอร์ต" />
        <Empty>
          ยังไม่มีข้อมูล — เริ่มจาก <Link className="text-accent underline" href="/holdings">เพิ่มสินทรัพย์</Link> แล้ว{" "}
          <Link className="text-accent underline" href="/transactions">บันทึกการซื้อ</Link> หรือให้ Claude / ChatGPT บันทึกให้ (ดูหน้า{" "}
          <Link className="text-accent underline" href="/settings">ตั้งค่า</Link>)
        </Empty>
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

  return (
    <>
      <PageHeader
        title="ภาพรวมพอร์ต"
        subtitle={perf.startDate ? `ตั้งแต่ ${perf.startDate} · Rf ${settings.riskFreeRate}%${settings.rfSource ? ` (${settings.rfSource})` : " (ค่าตัวอย่าง)"} · เทียบ ${settings.benchmarkSymbol}` : undefined}
        explain={{ topic: "ตัวเลขสรุปพอร์ต", data: kpiData, hint: "TWR วัดฝีมือการลงทุนตัดผลฝาก/ถอน; XIRR คือผลตอบแทนจริงของเงินที่รวมจังหวะเติมเงิน; Sharpe = ผลตอบแทนส่วนเกินต่อความผันผวน" }}
        action={<Link href="/data-quality" className="btn-ghost text-xs">คุณภาพข้อมูล →</Link>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="มูลค่าพอร์ต"
          value={fmtThb(summary.totalValueThb)}
          sub={`เงินสด ${fmtThb(summary.cashThb)}`}
          color="blue"
          ring={investedShare}
          ringLabel={investedShare != null ? `${Math.round(investedShare * 100)}%` : undefined}
          hint="วงแหวน = สัดส่วนที่ลงทุนอยู่ (ไม่ใช่เงินสด)"
        />
        <Stat
          label="กำไร/ขาดทุนรวม"
          value={fmtThb(summary.totalPnlThb)}
          tone={signClass(summary.totalPnlThb)}
          sub={`ลงทุนสุทธิ ${fmtThb(summary.netContributedThb)}`}
          color={summary.totalPnlThb >= 0 ? "green" : "red"}
          ring={pnlPct != null ? Math.abs(pnlPct) : null}
          ringLabel={pnlPct != null ? `${pnlPct >= 0 ? "+" : "−"}${Math.abs(pnlPct * 100).toFixed(0)}%` : undefined}
          hint="วงแหวน = กำไร/ขาดทุนเทียบกับเงินลงทุนสุทธิ"
        />
        {perf.displayReturnConvention === "annualized" ? (
          <Stat
            label="TWR ต่อปี"
            value={fmtPct(perf.annualizedReturn)}
            tone={signClass(perf.annualizedReturn)}
            sub={`สะสม ${fmtPct(perf.cumulativeReturn)}`}
            color="orange"
            ringLabel="TWR"
            hint="Time-weighted return: วัดฝีมือการลงทุน ตัดผลของการฝาก/ถอนเงิน"
          />
        ) : (
          <Stat
            label={`TWR สะสม (${perf.periodDays} วัน)`}
            value={fmtPct(perf.cumulativeReturn)}
            tone={signClass(perf.cumulativeReturn)}
            sub={`เทียบเท่าต่อปี (ประมาณการ) ${fmtPct(perf.annualizedEquivalent)}`}
            color="orange"
            ringLabel="TWR"
            hint="ช่วงข้อมูลสั้นกว่า 1 ปี จึงแสดงผลตอบแทนสะสมเป็นหลัก — ค่าเทียบเท่าต่อปีเป็นการขยายผล (extrapolation) ไม่ใช่ผลตอบแทนจริงต่อปี"
          />
        )}
        <Stat
          label="XIRR (MWR) ต่อปี"
          value={xirrText(perf.xirr)}
          tone={signClass(perf.xirr.rate)}
          sub={xirrNote(perf.xirr)}
          color="purple"
          ringLabel="IRR"
          hint="Money-weighted return: ผลตอบแทนจริงของเงินคุณ รวมจังหวะการเติมเงิน"
        />
        <Stat
          label="Sharpe ratio"
          value={fmtRatio(perf.sharpe)}
          sub={perf.sharpe == null ? `ข้อมูลไม่พอ (${perf.dataQuality.observations}/${perf.dataQuality.minRequired} จุด)` : `σ ${fmtPct(perf.volatility, 1)} · MDD ${fmtPct(perf.maxDrawdown, 1)}`}
          color="yellow"
          ringLabel="SR"
          hint="mean(Rp − Rf) / σ(Rp − Rf) × √N — ใช้ผลตอบแทนส่วนเกินรายงวด, N = จำนวนงวดต่อปีจากข้อมูลจริง"
        />
      </div>

      <DataQualityPanel issues={summary.issues} warnings={perf.dataQuality.warnings} reconciliation={summary.reconciliation} />

      <div className="grid gap-6 lg:grid-cols-5">
        <Section
          title="มูลค่าพอร์ต vs เงินลงทุน"
          subtitle="เส้นมูลค่าพอร์ตเทียบเงินที่ใส่เข้าไปสุทธิ"
          className="lg:col-span-3"
          explain={{ data: compact({ จุดข้อมูล: downsample(perf.valueSeries, 20), มูลค่าล่าสุด: summary.totalValueThb, ลงทุนสุทธิ: summary.netContributedThb }), hint: "ระยะห่างระหว่างเส้นมูลค่ากับเส้นเงินลงทุน = กำไร/ขาดทุนสะสม" }}
        >
          <ValueChart data={perf.valueSeries} />
        </Section>
        <Section title="Asset allocation" subtitle="สัดส่วนตามประเภทสินทรัพย์" className="lg:col-span-2" explain={{ data: compact(allocationData) }} action={<Link href="/settings" className="text-xs text-accent">ตั้งเป้า</Link>}>
          <AllocationDonut rows={allocation.rows} />
        </Section>
      </div>

      <Section title="สัดส่วนจริง vs เป้าหมาย" subtitle="ส่วนต่างจากเป้าและจำนวนเงินที่ต้องซื้อ/ขายเพื่อกลับเป้า" explain={{ data: compact(allocationData), hint: "ค่าบวกในซื้อขายเพื่อกลับเป้า = ควรซื้อเพิ่ม ค่าลบ = ขายออก (เพื่อกลับสู่สัดส่วนเป้าหมาย)" }}>
        <AllocationTable rows={allocation.rows} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-5">
        <Section
          title="ผลตอบแทนสะสม vs ดัชนีอ้างอิง"
          subtitle="การเติบโตของเงิน 1 บาท"
          className="lg:col-span-3"
          explain={{
            data: compact({ ดัชนีอ้างอิง: perf.benchmark?.symbol, ชนิดดัชนี: perf.benchmark?.kind, การเติบโต: downsample(perf.growth, 16), Beta: perf.benchmark?.regressionBeta, Alphaต่อปี: perf.benchmark?.regressionAlphaAnnual, AlphaStdError: perf.benchmark?.alphaStdError, ExcessReturnต่อปี: perf.realizedExcessReturn }),
            hint: "Beta = พอร์ตขยับแรงแค่ไหนเมื่อตลาดขยับ 1%; Alpha = ผลตอบแทนส่วนเกินที่อธิบายด้วยตลาดไม่ได้ (มี standard error)",
          }}
          action={<Link href="/analytics" className="text-xs text-accent">วิเคราะห์เพิ่ม →</Link>}>
          <GrowthChart data={perf.growth} benchmark={perf.benchmark?.symbol} />
          {perf.benchmark && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div>
                <div className="text-muted">Beta (OLS)</div>
                <div className="font-medium tabular-nums">{fmtRatio(perf.benchmark.regressionBeta)}</div>
              </div>
              <div>
                <div className="text-muted">Alpha ต่อปี (OLS)</div>
                <div className={`font-medium tabular-nums ${signClass(perf.benchmark.regressionAlphaAnnual)}`}>
                  {fmtPct(perf.benchmark.regressionAlphaAnnual)}
                  {perf.benchmark.alphaStdError != null && <span className="text-muted"> ±{fmtPct(perf.benchmark.alphaStdError)}</span>}
                </div>
              </div>
              <div>
                <div className="text-muted">Excess return (Rp − Rf)</div>
                <div className="font-medium tabular-nums">{fmtPct(perf.realizedExcessReturn)}</div>
              </div>
            </div>
          )}
          {perf.benchmark?.kind === "price_index" && (
            <p className="mt-2 text-xs text-muted">{perf.benchmark.symbol} เป็นดัชนีราคา (ไม่รวมปันผล) แต่พอร์ตรวมปันผล — การเทียบจึงเอียงเข้าข้างพอร์ต</p>
          )}
        </Section>
        <Section title="บันทึกล่าสุด" className="lg:col-span-2" action={<Link href="/journal" className="text-xs text-accent">ทั้งหมด →</Link>}>
          <div className="space-y-3">
            {notes.length ? notes.map((n) => <NoteCard key={n.id} note={n} compact />) : <Empty>ยังไม่มีบันทึก</Empty>}
          </div>
        </Section>
      </div>
    </>
  );
}
