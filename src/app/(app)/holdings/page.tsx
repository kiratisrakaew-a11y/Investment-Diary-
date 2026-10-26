import Link from "next/link";
import { getPortfolioSummary } from "@/server/services/portfolio";
import { listAssets } from "@/server/services/assets";
import { AddAssetForm, AddPriceForm } from "@/components/AssetForms";
import { UpdatePricesButton } from "@/components/UpdatePricesButton";
import { Empty, PageHeader, Section } from "@/components/ui";
import { ASSET_CLASS_COLOR, ASSET_CLASS_LABEL, fmtNum, fmtPctRaw, fmtQty, fmtThb, signClass } from "@/lib/format";

export default async function HoldingsPage() {
  const [summary, assets] = await Promise.all([getPortfolioSummary(), listAssets()]);
  const open = summary.positions.filter((p) => p.quantity > 0);
  const closed = summary.positions.filter((p) => p.quantity === 0);
  const untouched = assets.filter((a) => !summary.positions.some((p) => p.assetId === a.id));

  return (
    <>
      <PageHeader title="สินทรัพย์ที่ถือ" subtitle="ต้นทุนเฉลี่ย, มูลค่าตลาด และกำไร/ขาดทุน (บาท)" action={<UpdatePricesButton />} />

      <Section title="พอร์ตปัจจุบัน">
        {open.length === 0 ? (
          <Empty>ยังไม่มีสินทรัพย์ในพอร์ต</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>สินทรัพย์</th>
                  <th>ประเภท</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ต้นทุนเฉลี่ย (฿)</th>
                  <th className="num">ราคาล่าสุด</th>
                  <th className="num">มูลค่า</th>
                  <th className="num">กำไรยังไม่รับรู้</th>
                  <th className="num">รับรู้แล้ว + ปันผล</th>
                  <th className="num">น้ำหนัก</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.assetId}>
                    <td>
                      <Link href={`/holdings/${p.assetId}`} className="font-medium text-accent">{p.symbol}</Link>
                      <div className="text-xs text-muted">{p.name}</div>
                    </td>
                    <td className="text-xs">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: ASSET_CLASS_COLOR[p.assetClass] }} />
                      {ASSET_CLASS_LABEL[p.assetClass]}
                    </td>
                    <td className="num">{fmtQty(p.quantity)}</td>
                    <td className="num">{fmtNum(p.avgCostThb)}</td>
                    <td className="num">
                      {fmtNum(p.lastPrice)} <span className="text-xs text-muted">{p.currency}</span>
                      <div className="text-[11px] text-muted">{p.lastPriceDate ?? "ราคาซื้อ"}</div>
                    </td>
                    <td className="num">{fmtThb(p.marketValueThb)}</td>
                    <td className={`num ${signClass(p.unrealizedPnlThb)}`}>
                      {fmtThb(p.unrealizedPnlThb)}
                      <div className="text-[11px]">{fmtPctRaw(p.unrealizedPnlPct)}</div>
                    </td>
                    <td className={`num ${signClass(p.realizedPnlThb + p.incomeThb)}`}>{fmtThb(p.realizedPnlThb + p.incomeThb)}</td>
                    <td className="num">{fmtPctRaw(p.weightPct)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} className="text-muted">เงินสดในพอร์ต</td>
                  <td className="num">{fmtThb(summary.cashThb)}</td>
                  <td colSpan={2} />
                  <td className="num">{fmtPctRaw(summary.totalValueThb ? (summary.cashThb / summary.totalValueThb) * 100 : 0)}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={5}>รวม</td>
                  <td className="num">{fmtThb(summary.totalValueThb)}</td>
                  <td className={`num ${signClass(summary.totalPnlThb)}`} colSpan={2}>P&amp;L รวม {fmtThb(summary.totalPnlThb)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Section>

      {(closed.length > 0 || untouched.length > 0) && (
        <Section title="สินทรัพย์อื่น ๆ (ขายหมดแล้ว / ยังไม่ได้ซื้อ)">
          <div className="flex flex-wrap gap-2 text-sm">
            {[...closed.map((p) => ({ id: p.assetId, symbol: p.symbol, extra: `รับรู้ ${fmtThb(p.realizedPnlThb + p.incomeThb)}` })), ...untouched.map((a) => ({ id: a.id, symbol: a.symbol, extra: "" }))].map((a) => (
              <Link key={a.id} href={`/holdings/${a.id}`} className="btn-ghost">
                {a.symbol} {a.extra && <span className="text-xs text-muted">{a.extra}</span>}
              </Link>
            ))}
          </div>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="เพิ่มสินทรัพย์">
          <AddAssetForm />
        </Section>
        <Section title="บันทึกราคาเอง (พันธบัตร / กองทุน / ราคาที่ดึงไม่ได้)">
          {assets.length ? <AddPriceForm assets={assets} /> : <Empty>เพิ่มสินทรัพย์ก่อน</Empty>}
        </Section>
      </div>
    </>
  );
}
