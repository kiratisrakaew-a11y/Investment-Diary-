import { listAssets } from "@/server/services/assets";
import { listDividendEvents } from "@/server/services/dividends";
import { getDividendIncome } from "@/server/services/strategies";
import { IncomeChart } from "@/components/charts";
import { DividendStrategyPanel } from "@/components/DividendStrategyPanel";
import { DividendEventsPanel } from "@/components/DividendEventsPanel";
import { Card, KpiCard, PageHeader, Section } from "@/components/ui";
import { Tabs } from "@/components/ui-client";
import { DividendIncomeTable } from "@/components/DividendIncomeTable";
import { IconChip } from "@/components/icons";
import { Coins } from "@phosphor-icons/react/ssr";
import { fmtThb } from "@/lib/format";
import { compact } from "@/lib/explain-data";

export default async function DividendsPage() {
  const [assets, events, income] = await Promise.all([listAssets(), listDividendEvents(), getDividendIncome()]);
  const stocks = assets.filter((a) => !a.archivedAt && ["thai_stock", "us_stock", "fund"].includes(a.assetClass)).map((a) => a.symbol);
  const today = income.asOf;
  const sum = (status: string, past: boolean) =>
    income.rows.filter((r) => r.status === status && (past ? r.month <= today.slice(0, 7) : r.month >= today.slice(0, 7))).reduce((a, r) => a + (r.status === "received" ? (r.receivedThb ?? 0) : (r.netThb ?? 0)), 0) +
    (status === "received" && past ? income.unmatchedReceipts.reduce((a, u) => a + u.amountThb, 0) : 0);
  const received = sum("received", true);
  const missing = sum("missing_confirmation", true);
  const announced = sum("announced", false);
  const estimated = sum("estimated", false);

  return (
    <div className="space-y-6">
      <PageHeader
        title="ลงทุนเน้นปันผล"
        subtitle="คัดกรองหุ้นปันผล 3 แบบ · ปฏิทินรายได้ปันผล (แยกประกาศแล้ว / ประมาณการ / ได้รับจริง) · เหตุการณ์ปันผลของบริษัท — ใช้ข้อมูล ณ วันที่ตัดสินใจเท่านั้น"
        explain={{ topic: "ภาพรวมรายได้ปันผล", data: compact({ ได้รับแล้ว12เดือน: received, ถึงกำหนดยังไม่บันทึก: missing, ประกาศแล้วข้างหน้า: announced, ประมาณการข้างหน้า: estimated, รายปี: income.byYear }) }}
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="ได้รับแล้ว (12 เดือน)" value={fmtThb(received)} note="จากรายการ dividend ในบัญชี" icon={<IconChip category="stock" icon={Coins} label="ปันผลที่ได้รับ" />} />
        <KpiCard label="ถึงกำหนด ยังไม่บันทึก" value={fmtThb(missing)} valueClassName={missing > 0 ? "text-warning" : undefined} note="ตรวจว่าได้รับเงินแล้วหรือยัง" />
        <KpiCard label="ประกาศแล้ว (ข้างหน้า)" value={fmtThb(announced)} note="สุทธิหลังภาษี (สมมติฐาน)" />
        <KpiCard label="ประมาณการ (12 เดือน)" value={fmtThb(estimated)} note="จากปันผลปกติปีก่อน — ไม่ใช่การประกาศ" />
      </div>

      <Section
        title="รายได้ปันผลรายเดือน"
        subtitle={`${income.window.from} → ${income.window.to} · จัดเดือนตามวันจ่าย (ถ้าไม่ทราบใช้ ex-date) · สุทธิหลังภาษีหัก ณ ที่จ่าย เป็นบาท`}
        explain={{ data: compact({ รายเดือน: income.byMonth, ภาษีสมมติ: income.assumptions.withholding, ไม่มีข้อมูลปันผล: income.coverageGaps }), hint: "received = เงินที่บันทึกในบัญชีจริง; missing_confirmation = ถึงวันจ่ายแล้วแต่ยังไม่มีรายการรับเงิน; announced = ประกาศแล้วยังไม่ถึงวันจ่าย; estimated = คาดจากปีก่อน" }}
      >
        {income.byMonth.length ? <IncomeChart data={income.byMonth} /> : <p className="text-sm text-text-muted">ยังไม่มีข้อมูล — เพิ่มเหตุการณ์ปันผลด้านล่าง</p>}
        {income.coverageGaps.length > 0 && <p className="mt-2 text-xs text-warning">ไม่มีข้อมูลปันผลของ: {income.coverageGaps.join(", ")}</p>}
      </Section>

      <Section title="รายการปันผลที่คาดว่าจะได้รับ / ได้รับแล้ว" subtitle={income.note}>
        <DividendIncomeTable
          rows={income.rows.map((r) => ({ month: r.month, symbol: r.symbol, status: r.status as "received" | "missing_confirmation" | "announced" | "estimated", exDate: r.exDate, paymentDate: r.paymentDate ?? null, units: r.units, dps: r.dpsLatestBasis, currency: r.currency, gross: r.gross, withholdingRate: r.withholdingRate, netThb: r.netThb ?? null, receivedThb: r.receivedThb ?? null, notes: r.notes }))}
        />
        <ul className="mt-3 space-y-1 text-xs text-text-muted">
          {income.methodology.map((m) => (
            <li key={m}>• {m}</li>
          ))}
        </ul>
      </Section>

      <Card>
        <Tabs
          ariaLabel="เครื่องมือปันผล"
          tabs={[
            { id: "screen", label: "คัดกรองหุ้นปันผล", content: <DividendStrategyPanel symbols={stocks} /> },
            {
              id: "events",
              label: "เหตุการณ์ปันผลของบริษัท",
              content: (
                <div className="space-y-3">
                  <p className="text-xs text-text-muted">ข้อมูลผู้ออกหลักทรัพย์ (ไม่ใช่เงินที่ได้รับ)</p>
                  <DividendEventsPanel events={events.map((e) => ({ ...e, revisions: e.revisions ?? [] }))} symbols={stocks} />
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
