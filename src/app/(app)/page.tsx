import Link from "next/link";
import { getAllocation, getPerformance, getPortfolioSummary } from "@/server/services/portfolio";
import { listNotes } from "@/server/services/notes";
import { getSettings } from "@/server/services/settings";
import { AllocationDonut, GrowthChart, ValueChart } from "@/components/charts";
import { AllocationTable } from "@/components/AllocationTable";
import { Empty, PageHeader, Section, Stat } from "@/components/ui";
import { NoteCard } from "@/components/NoteCard";
import { fmtPct, fmtRatio, fmtThb, signClass } from "@/lib/format";

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

  return (
    <>
      <PageHeader title="ภาพรวมพอร์ต" subtitle={perf.startDate ? `ตั้งแต่ ${perf.startDate} · Rf ${settings.riskFreeRate}% · เทียบ ${settings.benchmarkSymbol}` : undefined} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="มูลค่าพอร์ต" value={fmtThb(summary.totalValueThb)} sub={`เงินสด ${fmtThb(summary.cashThb)}`} />
        <Stat
          label="กำไร/ขาดทุนรวม"
          value={fmtThb(summary.totalPnlThb)}
          tone={signClass(summary.totalPnlThb)}
          sub={`ลงทุนสุทธิ ${fmtThb(summary.netContributedThb)}`}
        />
        <Stat
          label="TWR ต่อปี"
          value={fmtPct(perf.twrAnnualized)}
          tone={signClass(perf.twrAnnualized)}
          sub={`สะสม ${fmtPct(perf.twrCumulative)}`}
          hint="Time-weighted return: วัดฝีมือการลงทุน ตัดผลของการฝาก/ถอนเงิน"
        />
        <Stat label="XIRR (MWR)" value={fmtPct(perf.mwrXirr)} tone={signClass(perf.mwrXirr)} hint="Money-weighted return: ผลตอบแทนจริงของเงินคุณ รวมจังหวะการเติมเงิน" />
        <Stat
          label="Sharpe ratio"
          value={fmtRatio(perf.sharpe)}
          sub={`σ ${fmtPct(perf.volatility, 1)} · MDD ${fmtPct(perf.maxDrawdown, 1)}`}
          hint="(Rp − Rf) / σp — ผลตอบแทนส่วนเกินต่อหนึ่งหน่วยความเสี่ยง"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Section title="มูลค่าพอร์ต vs เงินลงทุน" className="lg:col-span-3">
          <ValueChart data={perf.valueSeries} />
        </Section>
        <Section title="Asset allocation" className="lg:col-span-2" action={<Link href="/settings" className="text-xs text-accent">ตั้งเป้า</Link>}>
          <AllocationDonut rows={allocation.rows} />
        </Section>
      </div>

      <Section title="สัดส่วนจริง vs เป้าหมาย">
        <AllocationTable rows={allocation.rows} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-5">
        <Section title="ผลตอบแทนสะสม vs ดัชนีอ้างอิง" className="lg:col-span-3" action={<Link href="/analytics" className="text-xs text-accent">วิเคราะห์เพิ่ม →</Link>}>
          <GrowthChart data={perf.growth} benchmark={perf.benchmark?.symbol} />
          {perf.benchmark && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div>
                <div className="text-muted">Beta</div>
                <div className="font-medium tabular-nums">{fmtRatio(perf.benchmark.beta)}</div>
              </div>
              <div>
                <div className="text-muted">Jensen&apos;s α</div>
                <div className={`font-medium tabular-nums ${signClass(perf.benchmark.jensenAlpha)}`}>{fmtPct(perf.benchmark.jensenAlpha)}</div>
              </div>
              <div>
                <div className="text-muted">Risk premium</div>
                <div className="font-medium tabular-nums">{fmtPct(perf.riskPremium)}</div>
              </div>
            </div>
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
