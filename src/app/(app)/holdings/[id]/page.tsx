import Link from "next/link";
import { notFound } from "next/navigation";
import { getAsset, listAssets } from "@/server/services/assets";
import { priceHistoryFor } from "@/server/services/prices";
import { listTransactions } from "@/server/services/transactions";
import { listNotes } from "@/server/services/notes";
import { getPortfolioSummary } from "@/server/services/portfolio";
import { PriceChart } from "@/components/charts";
import { NoteCard } from "@/components/NoteCard";
import { AddPriceForm, BondConventionFields } from "@/components/AssetForms";
import { ActionForm } from "@/components/ActionForm";
import { Empty, PageHeader, Section, Stat } from "@/components/ui";
import { AssetProfileForm } from "@/components/AssetProfileForm";
import { today } from "@/lib/validation";
import { readBondTerms, riskFreeEligibility } from "@/lib/finance/bond-meta";
import { updateBondTermsAction } from "../../actions";
import { AssetActionsMenu } from "@/components/AssetActionsMenu";
import { assetDependencies } from "@/server/services/asset-lifecycle";
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
  const deps = await assetDependencies(id);
  const terms = readBondTerms(asset.bondTerms);
  const eligibility = riskFreeEligibility(asset, terms);

  return (
    <>
      <PageHeader
        title={`${asset.symbol} · ${asset.name}${asset.archivedAt ? " (เก็บถาวร)" : asset.hiddenInHoldingsAt ? " (ซ่อนอยู่)" : ""}`}
        subtitle={`${ASSET_CLASS_LABEL[asset.assetClass]} · ${asset.currency} · ราคา: ${asset.priceSource}${asset.providerSymbol ? ` (${asset.providerSymbol})` : ""}${asset.couponRate ? ` · คูปอง ${asset.couponRate}%` : ""}${asset.maturityDate ? ` · ครบกำหนด ${asset.maturityDate}` : ""}`}
        action={
          <div className="flex items-center gap-3">
            {(asset.assetClass === "thai_stock" || asset.assetClass === "us_stock") && (
              <Link href={`/valuation/new?symbol=${asset.symbol}`} className="btn-ghost">ประเมินมูลค่า</Link>
            )}
            {asset.assetClass === "bond" && <Link href="/bonds" className="btn-ghost">คำนวณ YTM</Link>}
            <AssetActionsMenu
              variant="page"
              asset={{ id, symbol: asset.symbol }}
              hidden={!!asset.hiddenInHoldingsAt}
              archived={!!asset.archivedAt}
              held={(pos?.quantity ?? 0) !== 0}
              dependencyCount={deps ? Object.values(deps).reduce((a, b) => a + b, 0) : 0}
            />
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
      {asset.assetClass === "bond" && (
        <Section title="เงื่อนไขพันธบัตร (ใช้คำนวณ YTM / duration ในพอร์ต)">
          <ActionForm action={updateBondTermsAction.bind(null, id)} className="grid gap-3 sm:grid-cols-5" resetOnSuccess={false}>
            <div>
              <label className="label">ดอกเบี้ยหน้าตั๋ว %</label>
              <input name="couponRate" type="number" step="any" className="input" defaultValue={asset.couponRate ?? ""} />
            </div>
            <div>
              <label className="label">วันครบกำหนด</label>
              <input name="maturityDate" type="date" className="input" defaultValue={asset.maturityDate ?? ""} />
            </div>
            <div>
              <label className="label">มูลค่าที่ตราไว้</label>
              <input name="faceValue" type="number" step="any" className="input" defaultValue={asset.faceValue ?? ""} />
            </div>
            <BondConventionFields frequency={asset.couponFrequency} dayCount={asset.dayCount} />
            <div className="sm:col-span-5 mt-1 border-t border-border pt-3 text-xs font-medium text-muted">ข้อมูลผู้ออกและลักษณะตราสาร (ไม่บังคับ — ใช้ตรวจความเหมาะสมเป็นตัวแทนปลอดความเสี่ยง)</div>
            <div>
              <label className="label" htmlFor="issuerType">ประเภทผู้ออก</label>
              <select id="issuerType" name="issuerType" className="input" defaultValue={terms.issuerType ?? ""}>
                <option value="">ไม่ระบุ</option>
                <option value="sovereign">รัฐบาล (sovereign)</option>
                <option value="agency">หน่วยงานรัฐ (agency)</option>
                <option value="state_enterprise">รัฐวิสาหกิจ</option>
                <option value="corporate">เอกชน</option>
                <option value="financial">สถาบันการเงิน</option>
                <option value="supranational">องค์กรระหว่างประเทศ</option>
                <option value="other">อื่น ๆ</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="issuerCountry">ประเทศผู้ออก (ISO 2 ตัว)</label>
              <input id="issuerCountry" name="issuerCountry" maxLength={2} className="input" placeholder="TH" defaultValue={terms.issuerCountry ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="couponType">ประเภทคูปอง</label>
              <select id="couponType" name="couponType" className="input" defaultValue={terms.couponType ?? ""}>
                <option value="">ไม่ระบุ</option>
                <option value="fixed">คงที่</option>
                <option value="floating">ลอยตัว</option>
                <option value="zero">ศูนย์ (zero coupon)</option>
                <option value="step">ขั้นบันได</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="isin">ISIN</label>
              <input id="isin" name="isin" className="input" defaultValue={terms.identifiers?.isin ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="thaiBma">ThaiBMA symbol</label>
              <input id="thaiBma" name="thaiBma" className="input" defaultValue={terms.identifiers?.thaiBma ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="termsSource">แหล่งที่มา</label>
              <input id="termsSource" name="termsSource" className="input" placeholder="เช่น หนังสือชี้ชวน / ThaiBMA" defaultValue={terms.source ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="termsAsOf">ตรวจสอบ ณ วันที่</label>
              <input id="termsAsOf" name="termsAsOf" type="date" className="input" defaultValue={terms.asOf ?? ""} />
            </div>
            <div className="flex flex-col justify-end gap-1 pb-1 text-sm sm:col-span-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="callable" defaultChecked={!!terms.callable} /> Callable (ผู้ออกไถ่ถอนก่อนได้)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="puttable" defaultChecked={!!terms.puttable} /> Puttable
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="riskFreeProxyEligible" defaultChecked={!!terms.riskFreeProxyEligible} /> ใช้เป็นตัวแทนปลอดความเสี่ยงได้ (eligibility เท่านั้น)
              </label>
            </div>
            <p className="text-xs text-muted sm:col-span-5">
              {eligibility.eligible
                ? "ผ่านเกณฑ์ตัวแทนปลอดความเสี่ยง — ระบบไม่ได้นำ YTM ของพันธบัตรนี้ไปใช้เป็น Rf ให้อัตโนมัติ (Rf มาจาก yield curve / หน้าตั้งค่า) และพันธบัตรที่ถือยังมีความเสี่ยงราคาก่อนครบกำหนด"
                : `ยังไม่ผ่านเกณฑ์ตัวแทนปลอดความเสี่ยง: ${eligibility.reasons.join(" · ")}`}
            </p>
          </ActionForm>
        </Section>
      )}
      <Section title="ผู้ออกและหมวด (ใช้กับข้อจำกัดความเสี่ยง)">
        <AssetProfileForm symbol={asset.symbol} issuer={asset.issuer} sector={asset.sector} sectorSource={asset.sectorSource} sectorAsOf={asset.sectorAsOf} today={today()} />
      </Section>

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
