import { listAssets } from "@/server/services/assets";
import { listDividendEvents } from "@/server/services/dividends";
import { getDividendIncome } from "@/server/services/strategies";
import { IncomeChart } from "@/components/charts";
import { DividendStrategyPanel } from "@/components/DividendStrategyPanel";
import { DividendEventsPanel } from "@/components/DividendEventsPanel";
import { Badge, PageHeader, Section, Stat } from "@/components/ui";
import { fmtNum, fmtPct, fmtThb } from "@/lib/format";
import { compact } from "@/lib/explain-data";

const STATUS: Record<string, { label: string; cls: string }> = {
  received: { label: "ได้รับแล้ว", cls: "border-pos/40 text-pos" },
  missing_confirmation: { label: "ถึงกำหนด ยังไม่บันทึก", cls: "border-warn/40 text-warn" },
  announced: { label: "ประกาศแล้ว", cls: "border-info/40 text-info" },
  estimated: { label: "ประมาณการ", cls: "" },
};

export default async function DividendsPage() {
  const [assets, events, income] = await Promise.all([listAssets(), listDividendEvents(), getDividendIncome()]);
  const stocks = assets.filter((a) => ["thai_stock", "us_stock", "fund"].includes(a.assetClass)).map((a) => a.symbol);
  const today = income.asOf;
  const sum = (status: string, past: boolean) =>
    income.rows.filter((r) => r.status === status && (past ? r.month <= today.slice(0, 7) : r.month >= today.slice(0, 7))).reduce((a, r) => a + (r.status === "received" ? (r.receivedThb ?? 0) : (r.netThb ?? 0)), 0) +
    (status === "received" && past ? income.unmatchedReceipts.reduce((a, u) => a + u.amountThb, 0) : 0);
  const received = sum("received", true);
  const missing = sum("missing_confirmation", true);
  const announced = sum("announced", false);
  const estimated = sum("estimated", false);

  return (
    <>
      <PageHeader
        title="ลงทุนเน้นปันผล"
        subtitle="คัดกรองหุ้นปันผล 3 แบบ · ปฏิทินรายได้ปันผล (แยกประกาศแล้ว / ประมาณการ / ได้รับจริง) · เหตุการณ์ปันผลของบริษัท — ใช้ข้อมูล ณ วันที่ตัดสินใจเท่านั้น"
        explain={{ topic: "ภาพรวมรายได้ปันผล", data: compact({ ได้รับแล้ว12เดือน: received, ถึงกำหนดยังไม่บันทึก: missing, ประกาศแล้วข้างหน้า: announced, ประมาณการข้างหน้า: estimated, รายปี: income.byYear }) }}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="ได้รับแล้ว (12 เดือน)" value={fmtThb(received)} sub="จากรายการ dividend ในบัญชี" color="green" />
        <Stat label="ถึงกำหนด ยังไม่บันทึก" value={fmtThb(missing)} sub="ตรวจว่าได้รับเงินแล้วหรือยัง" color="yellow" />
        <Stat label="ประกาศแล้ว (ข้างหน้า)" value={fmtThb(announced)} sub="สุทธิหลังภาษี (สมมติฐาน)" color="blue" />
        <Stat label="ประมาณการ (12 เดือน)" value={fmtThb(estimated)} sub="จากปันผลปกติปีก่อน — ไม่ใช่การประกาศ" color="purple" />
      </div>

      <Section
        title="รายได้ปันผลรายเดือน"
        subtitle={`${income.window.from} → ${income.window.to} · จัดเดือนตามวันจ่าย (ถ้าไม่ทราบใช้ ex-date) · สุทธิหลังภาษีหัก ณ ที่จ่าย เป็นบาท`}
        explain={{ data: compact({ รายเดือน: income.byMonth, ภาษีสมมติ: income.assumptions.withholding, ไม่มีข้อมูลปันผล: income.coverageGaps }), hint: "received = เงินที่บันทึกในบัญชีจริง; missing_confirmation = ถึงวันจ่ายแล้วแต่ยังไม่มีรายการรับเงิน; announced = ประกาศแล้วยังไม่ถึงวันจ่าย; estimated = คาดจากปีก่อน" }}
      >
        {income.byMonth.length ? <IncomeChart data={income.byMonth} /> : <p className="text-sm text-muted">ยังไม่มีข้อมูล — เพิ่มเหตุการณ์ปันผลด้านล่าง</p>}
        {income.coverageGaps.length > 0 && <p className="mt-2 text-xs text-warn">ไม่มีข้อมูลปันผลของ: {income.coverageGaps.join(", ")}</p>}
      </Section>

      <Section title="รายการปันผลที่คาดว่าจะได้รับ / ได้รับแล้ว" subtitle={income.note}>
        <div className="max-h-[28rem] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>เดือน</th>
                <th>หุ้น</th>
                <th>สถานะ</th>
                <th>ex-date</th>
                <th>วันจ่าย</th>
                <th className="num">หุ้นที่มีสิทธิ์</th>
                <th className="num">ต่อหุ้น</th>
                <th className="num">ก่อนภาษี</th>
                <th className="num">ภาษี</th>
                <th className="num">สุทธิ (บาท)</th>
                <th className="num">รับจริง (บาท)</th>
              </tr>
            </thead>
            <tbody>
              {income.rows.map((r, i) => (
                <tr key={i} title={r.notes.join(" · ")}>
                  <td>{r.month}</td>
                  <td className="font-medium">{r.symbol}</td>
                  <td>
                    <Badge className={STATUS[r.status].cls}>{STATUS[r.status].label}</Badge>
                  </td>
                  <td>{r.exDate}</td>
                  <td>{r.paymentDate ?? <span className="text-muted">ไม่ทราบ</span>}</td>
                  <td className="num">{fmtNum(r.units, 0)}</td>
                  <td className="num">
                    {fmtNum(r.dpsLatestBasis, 4)} {r.currency !== "THB" && r.currency}
                  </td>
                  <td className="num">{fmtNum(r.gross, 2)}</td>
                  <td className="num text-muted">{fmtPct(r.withholdingRate, 0)}</td>
                  <td className="num">{r.netThb == null ? "–" : fmtThb(r.netThb)}</td>
                  <td className="num">{r.receivedThb == null ? "" : fmtThb(r.receivedThb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 space-y-0.5 text-xs text-muted">
          {income.methodology.map((m) => (
            <li key={m}>• {m}</li>
          ))}
        </ul>
      </Section>

      <DividendStrategyPanel symbols={stocks} />

      <Section title="เหตุการณ์ปันผลของบริษัท" subtitle="ข้อมูลผู้ออกหลักทรัพย์ (ไม่ใช่เงินที่ได้รับ)">
        <DividendEventsPanel
          events={events.map((e) => ({ ...e, revisions: e.revisions ?? [] }))}
          symbols={stocks}
        />
      </Section>
    </>
  );
}
