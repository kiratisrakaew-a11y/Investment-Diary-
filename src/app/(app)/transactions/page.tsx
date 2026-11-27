import { listTransactions } from "@/server/services/transactions";
import { listAssets } from "@/server/services/assets";
import { listNotes } from "@/server/services/notes";
import { ActionForm } from "@/components/ActionForm";
import { Collapsible, EmptyState, KpiCard, PageHeader, Section } from "@/components/ui";
import { TxHistoryTable } from "@/components/TxHistoryTable";
import { OpenDetailsLink } from "@/components/OpenDetailsLink";
import { EmptyIcon, IconChip } from "@/components/icons";
import { ArrowsLeftRight } from "@phosphor-icons/react/ssr";
import { addTransactionAction, deleteTransactionAction } from "../actions";
import { SplitForm } from "@/components/SplitForm";
import { TX_TYPE_LABEL, fmtThb } from "@/lib/format";
import { today } from "@/lib/validation";

export default async function TransactionsPage() {
  const [txs, assets, notes] = await Promise.all([listTransactions(), listAssets(), listNotes({ limit: 50 })]);

  const sum = (types: string[]) => txs.filter(({ tx }) => types.includes(tx.type)).reduce((a, { tx }) => a + (tx.type === "buy" || tx.type === "sell" ? tx.quantity * tx.price : tx.price) * tx.fxRate, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="รายการซื้อขาย" subtitle="ซื้อ/ขาย, ปันผล, ดอกเบี้ยพันธบัตร, ฝาก/ถอนเงิน" action={<OpenDetailsLink targetId="new-tx">+ บันทึกรายการ</OpenDetailsLink>} />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="รายการทั้งหมด" value={String(txs.length)} icon={<IconChip category="stock" icon={ArrowsLeftRight} label="รายการ" />} />
        <KpiCard label="ซื้อรวม" value={fmtThb(sum(["buy"]))} note="บาท ตามอัตราแลกเปลี่ยนวันนั้น" />
        <KpiCard label="ขายรวม" value={fmtThb(sum(["sell"]))} />
        <KpiCard label="ปันผล + ดอกเบี้ย" value={fmtThb(sum(["dividend", "coupon"]))} />
      </div>

      <details id="new-tx" className="card">
        <summary className="cursor-pointer font-medium">บันทึกรายการใหม่</summary>
        <div className="mt-4">
        <ActionForm action={addTransactionAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className="label">วันที่</label>
              <input name="date" type="date" className="input" defaultValue={today()} />
            </div>
            <div>
              <label className="label">ประเภท</label>
              <select name="type" className="input">
                {Object.entries(TX_TYPE_LABEL).filter(([v]) => v !== "split").map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">สินทรัพย์ (เว้นว่างถ้าฝาก/ถอน)</label>
              <select name="symbol" className="input">
                <option value="">—</option>
                {assets
                  .filter((a) => !a.archivedAt)
                  .map((a) => (
                    <option key={a.id} value={a.symbol}>
                      {a.symbol} ({a.currency})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label">จำนวนหน่วย (ซื้อ/ขาย)</label>
              <input name="quantity" type="number" step="any" min={0} className="input" />
            </div>
            <div>
              <label className="label">ราคาต่อหน่วย / จำนวนเงินรวม</label>
              <input name="price" type="number" step="any" min={0} className="input" required />
            </div>
            <div>
              <label className="label">ค่าธรรมเนียม + ภาษี</label>
              <input name="fee" type="number" step="any" min={0} className="input" />
            </div>
            <div>
              <label className="label">อัตราแลกเปลี่ยน (฿/USD)</label>
              <input name="fxRate" type="number" step="any" className="input" placeholder="อัตโนมัติ" />
            </div>
            <div>
              <label className="label">ผูกกับบันทึก</label>
              <select name="noteId" className="input">
                <option value="">—</option>
                {notes.map((n) => (
                  <option key={n.id} value={n.id}>{n.date} · {n.title.slice(0, 40)}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">หมายเหตุ</label>
            <input name="memo" className="input" />
          </div>
        </ActionForm>
        </div>
      </details>

      <Section title="ประวัติรายการ">
        {txs.length === 0 ? (
          <EmptyState icon={<EmptyIcon icon={ArrowsLeftRight} />} title="ยังไม่มีรายการ" description="บันทึกการซื้อ ขาย ปันผล หรือฝาก/ถอนเงินรายการแรก" action={<OpenDetailsLink targetId="new-tx">+ บันทึกรายการ</OpenDetailsLink>} />
        ) : (
          <TxHistoryTable
            deleteAction={deleteTransactionAction}
            rows={txs.map(({ tx, symbol, currency }) => ({ id: tx.id, date: tx.date, type: tx.type, symbol: symbol ?? null, quantity: tx.quantity, price: tx.price, currency: currency ?? null, fee: tx.fee ?? null, valueThb: (tx.type === "buy" || tx.type === "sell" ? tx.quantity * tx.price : tx.price) * tx.fxRate, source: tx.source, memo: tx.memo ?? null }))}
          />
        )}
      </Section>

      <Collapsible title="แตกพาร์ / รวมพาร์ (stock split)">
        {assets.length ? <SplitForm symbols={assets.filter((a) => a.assetClass !== "cash").map((a) => a.symbol)} today={today()} /> : null}
        <p className="mt-2 text-xs text-text-muted">
          จำนวนหุ้นคูณตามอัตรา ต้นทุนรวมเท่าเดิม (ต้นทุนเฉลี่ยหาร) ไม่กระทบเงินสดและกำไรขาดทุน · รายการซื้อขายเก่าไม่ถูกแก้ · เศษหุ้นที่ได้เป็นเงินสด ให้บันทึกเป็น &quot;ขาย&quot; แยก
        </p>
      </Collapsible>
    </div>
  );
}
