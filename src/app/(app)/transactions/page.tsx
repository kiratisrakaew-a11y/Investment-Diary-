import { listTransactions } from "@/server/services/transactions";
import { listAssets } from "@/server/services/assets";
import { listNotes } from "@/server/services/notes";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Badge, Empty, PageHeader, Section } from "@/components/ui";
import { addTransactionAction, deleteTransactionAction } from "../actions";
import { TX_TYPE_LABEL, fmtNum, fmtQty, fmtThb } from "@/lib/format";
import { today } from "@/lib/validation";

export default async function TransactionsPage() {
  const [txs, assets, notes] = await Promise.all([listTransactions(), listAssets(), listNotes({ limit: 50 })]);

  return (
    <>
      <PageHeader title="รายการซื้อขาย" subtitle="ซื้อ/ขาย, ปันผล, ดอกเบี้ยพันธบัตร, ฝาก/ถอนเงิน" />

      <Section title="บันทึกรายการใหม่">
        <ActionForm action={addTransactionAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className="label">วันที่</label>
              <input name="date" type="date" className="input" defaultValue={today()} />
            </div>
            <div>
              <label className="label">ประเภท</label>
              <select name="type" className="input">
                {Object.entries(TX_TYPE_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">สินทรัพย์ (เว้นว่างถ้าฝาก/ถอน)</label>
              <select name="symbol" className="input">
                <option value="">—</option>
                {assets.map((a) => (
                  <option key={a.id} value={a.symbol}>{a.symbol} ({a.currency})</option>
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
      </Section>

      <Section title="ประวัติรายการ">
        {txs.length === 0 ? (
          <Empty>ยังไม่มีรายการ</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ประเภท</th>
                  <th>สินทรัพย์</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ราคา/จำนวนเงิน</th>
                  <th className="num">ค่าธรรมเนียม</th>
                  <th className="num">มูลค่า (฿)</th>
                  <th>หมายเหตุ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {txs.map(({ tx, symbol, currency }) => {
                  const gross = tx.type === "buy" || tx.type === "sell" ? tx.quantity * tx.price : tx.price;
                  return (
                    <tr key={tx.id}>
                      <td>{tx.date}</td>
                      <td>{TX_TYPE_LABEL[tx.type]}</td>
                      <td className="font-medium">{symbol ?? "เงินสด"}</td>
                      <td className="num">{tx.quantity ? fmtQty(tx.quantity) : "–"}</td>
                      <td className="num">
                        {fmtNum(tx.price)} <span className="text-xs text-muted">{currency ?? "THB"}</span>
                      </td>
                      <td className="num">{tx.fee ? fmtNum(tx.fee) : "–"}</td>
                      <td className="num">{fmtThb(gross * tx.fxRate)}</td>
                      <td className="max-w-48 truncate text-xs text-muted">
                        {tx.source !== "web" && <Badge className="mr-1">{tx.source}</Badge>}
                        {tx.memo}
                      </td>
                      <td>
                        <ConfirmButton onConfirm={deleteTransactionAction.bind(null, tx.id)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
