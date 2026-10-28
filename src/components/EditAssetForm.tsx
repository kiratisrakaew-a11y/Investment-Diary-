"use client";

/**
 * Correct an existing asset's symbol, name, class, currency, price source and price code.
 * Submitted via onSubmit (not `action=`): React 19 resets a form after an `action=` submit, which would
 * show the old values again after an error or a save.
 */
import { startTransition, useActionState, useState } from "react";
import { editAssetBasicsAction } from "@/app/(app)/actions";

interface Basics {
  id: number;
  symbol: string;
  name: string;
  assetClass: string;
  currency: string;
  priceSource: string;
  providerSymbol: string | null;
}

export function EditAssetForm({ asset, hasHistory }: { asset: Basics; hasHistory: boolean }) {
  const [state, formAction, pending] = useActionState(editAssetBasicsAction.bind(null, asset.id), null);
  const [v, setV] = useState({ ...asset, providerSymbol: asset.providerSymbol ?? "" });
  const [confirm, setConfirm] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const typeChanged = v.assetClass !== asset.assetClass || v.currency !== asset.currency;
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      <div>
        <label className="label" htmlFor="ea-symbol">สัญลักษณ์ (symbol)</label>
        <input id="ea-symbol" name="symbol" className="input uppercase" required maxLength={40} value={v.symbol} onChange={set("symbol")} />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="ea-name">ชื่อ</label>
        <input id="ea-name" name="name" className="input" required maxLength={200} value={v.name} onChange={set("name")} />
      </div>
      <div>
        <label className="label" htmlFor="ea-class">ประเภท</label>
        <select id="ea-class" name="assetClass" className="input" value={v.assetClass} onChange={set("assetClass")}>
          <option value="thai_stock">หุ้นไทย</option>
          <option value="us_stock">หุ้นต่างประเทศ</option>
          <option value="bond">พันธบัตร/หุ้นกู้</option>
          <option value="fund">กองทุนรวม</option>
          <option value="gold">ทองคำ</option>
          <option value="cash">เงินฝาก/เงินสด</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="ea-currency">สกุลเงิน</label>
        <select id="ea-currency" name="currency" className="input" value={v.currency} onChange={set("currency")}>
          <option>THB</option>
          <option>USD</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="ea-source">แหล่งราคา</label>
        <select id="ea-source" name="priceSource" className="input" value={v.priceSource} onChange={set("priceSource")}>
          <option value="yahoo">Yahoo Finance (อัตโนมัติ)</option>
          <option value="sec_th">ก.ล.ต. (NAV กองทุนไทย)</option>
          <option value="manual">กรอกเอง</option>
        </select>
      </div>
      <div className="sm:col-span-3">
        <label className="label" htmlFor="ea-provider">
          รหัสที่ใช้ดึงราคา — หุ้นไทย <code>AP.BK</code>, หุ้น US <code>AAPL</code>, ทองแท่งไทย <code>GOLD_TH</code>, กองทุนไทย = proj_id (เว้นว่าง = ไม่ใช้)
        </label>
        <input id="ea-provider" name="providerSymbol" className="input" maxLength={60} value={v.providerSymbol} onChange={set("providerSymbol")} placeholder="AP.BK" />
      </div>
      <p className="text-[11px] text-muted sm:col-span-3">
        แก้ symbol แล้วรายการซื้อขาย ราคา ตัวชี้วัด และบันทึกยังผูกอยู่ครบ (อ้างด้วย id) — valuation งบการเงิน และปันผลจะเปลี่ยนตาม symbol ใหม่ด้วย ระบบแปลงเป็นตัวพิมพ์ใหญ่ให้
      </p>
      {hasHistory && typeChanged && (
        <label className="flex items-start gap-2 text-[11px] text-warn sm:col-span-3">
          <input type="checkbox" name="confirmChange" className="mt-0.5" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>ยืนยันเปลี่ยนประเภท/สกุลเงิน — มีรายการซื้อขายหรือราคาแล้ว ค่าเดิมจะไม่ถูกแปลงให้</span>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-1 sm:col-span-3">
        <button className="btn" disabled={pending}>
          {pending ? "กำลังบันทึก…" : "บันทึก"}
        </button>
        {state?.error && (
          <span role="alert" className="text-sm text-neg">
            {state.error}
          </span>
        )}
        {state?.ok && state.message && (
          <span role="status" className="text-sm text-pos">
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
