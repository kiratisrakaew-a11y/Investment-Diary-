import Link from "next/link";
import { notFound } from "next/navigation";
import { getAsset, listAssets } from "@/server/services/assets";
import { priceHistoryFor } from "@/server/services/prices";
import { listTransactions } from "@/server/services/transactions";
import { listNotes } from "@/server/services/notes";
import { getPortfolioSummary } from "@/server/services/portfolio";
import { PriceChart } from "@/components/charts";
import { NoteCard } from "@/components/NoteCard";
import { AddPriceForm } from "@/components/AssetForms";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Empty, PageHeader, Section, Stat } from "@/components/ui";
import { deleteAssetAction } from "../../actions";
import { ASSET_CLASS_LABEL, TX_TYPE_LABEL, fmtNum, fmtPctRaw, fmtQty, fmtThb, signClass } from "@/lib/format";

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const asset = await getAsset(id);
  if (!asset) notFound();
  const [prices, txs, notes, summary, assets] = await Promise.all([
    priceHistoryFor(id),
    listTransactions({ assetId: id }),
    listNotes({ assetId: id }),
    getPortfolioSummary(),
    listAssets(),
  ]);
  const pos = summary.positions.find((p) => p.assetId === id);

  return (
    <>
      <PageHeader
        title={`${asset.symbol} · ${asset.name}`}
        subtitle={`${ASSET_CLASS_LABEL[asset.assetClass]} · ${asset.currency} · ราคา: ${asset.priceSource}${asset.providerSymbol ? ` (${asset.providerSymbol})` : ""}${asset.couponRate ? ` · คูปอง ${asset.couponRate}%` : ""}${asset.maturityDate ? ` · ครบกำหนด ${asset.maturityDate}` : ""}`}
        action={
          <div className="flex items-center gap-3">
            {(asset.assetClass === "thai_stock" || asset.assetClass === "us_stock") && (
              <Link href={`/valuation/new?symbol=${asset.symbol}`} className="btn-ghost">ประเมินมูลค่า</Link>
            )}
            {asset.assetClass === "bond" && <Link href="/bonds" className="btn-ghost">คำนวณ YTM</Link>}
            <ConfirmButton onConfirm={deleteAssetAction.bind(null, id)} label="ลบสินทรัพย์" message="ลบสินทรัพย์นี้พร้อมรายการและราคาทั้งหมด?" />
          </div>
        }
      />
      {pos && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="จำนวน" value={fmtQty(pos.quantity)} sub={`ต้นทุนเฉลี่ย ฿${fmtNum(pos.avgCostThb)}`} />
          <Stat label="มูลค่าตลาด" value={fmtThb(pos.marketValueThb)} sub={`น้ำหนัก ${fmtPctRaw(pos.weightPct)}`} />
          <Stat label="กำไรยังไม่รับรู้" value={fmtThb(pos.unrealizedPnlThb)} tone={signClass(pos.unrealizedPnlThb)} sub={fmtPctRaw(pos.unrealizedPnlPct)} />
          <Stat label="รับรู้แล้ว + ปันผล" value={fmtThb(pos.realizedPnlThb + pos.incomeThb)} tone={signClass(pos.realizedPnlThb + pos.incomeThb)} />
        </div>
      )}
      <Section title={`ราคา (${asset.currency})`}>
        {prices.length > 1 ? <PriceChart data={prices} currency={asset.currency} /> : <Empty>ยังไม่มีประวัติราคา</Empty>}
        <div className="mt-4">
          <AddPriceForm assets={assets} symbol={asset.symbol} />
        </div>
      </Section>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="รายการซื้อขาย">
          {txs.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ประเภท</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ราคา</th>
                </tr>
              </thead>
              <tbody>
                {txs.map(({ tx }) => (
                  <tr key={tx.id}>
                    <td>{tx.date}</td>
                    <td>{TX_TYPE_LABEL[tx.type]}</td>
                    <td className="num">{tx.quantity ? fmtQty(tx.quantity) : "–"}</td>
                    <td className="num">{fmtNum(tx.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>ยังไม่มีรายการ</Empty>
          )}
        </Section>
        <Section title="บันทึกที่เกี่ยวข้อง">
          <div className="space-y-4">{notes.length ? notes.map((n) => <NoteCard key={n.id} note={n} />) : <Empty>ยังไม่มีบันทึก</Empty>}</div>
        </Section>
      </div>
    </>
  );
}
