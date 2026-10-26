import { addAssetAction, addPriceAction } from "@/app/(app)/actions";
import { today } from "@/lib/validation";
import { ActionForm } from "./ActionForm";
import type { Asset } from "@/db/schema";

export function AddAssetForm() {
  return (
    <ActionForm action={addAssetAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">สัญลักษณ์</label>
          <input name="symbol" className="input" required placeholder="PTT" />
        </div>
        <div className="sm:col-span-2">
          <label className="label">ชื่อ</label>
          <input name="name" className="input" required placeholder="PTT Public Company" />
        </div>
        <div>
          <label className="label">ประเภท</label>
          <select name="assetClass" className="input">
            <option value="thai_stock">หุ้นไทย</option>
            <option value="us_stock">หุ้นต่างประเทศ</option>
            <option value="bond">พันธบัตร/หุ้นกู้</option>
            <option value="fund">กองทุนรวม</option>
            <option value="gold">ทองคำ</option>
            <option value="cash">เงินฝาก/เงินสด</option>
          </select>
        </div>
        <div>
          <label className="label">สกุลเงิน</label>
          <select name="currency" className="input">
            <option>THB</option>
            <option>USD</option>
          </select>
        </div>
        <div>
          <label className="label">แหล่งราคา</label>
          <select name="priceSource" className="input">
            <option value="yahoo">Yahoo Finance (อัตโนมัติ)</option>
            <option value="sec_th">ก.ล.ต. (NAV กองทุนไทย)</option>
            <option value="manual">กรอกเอง</option>
          </select>
        </div>
        <div className="sm:col-span-3">
          <label className="label">รหัสที่ผู้ให้ราคาใช้ — หุ้นไทย <code>PTT.BK</code>, หุ้น US <code>AAPL</code>, ทองแท่งไทย <code>GOLD_TH</code>, กองทุนไทย = proj_id ของ ก.ล.ต.</label>
          <input name="providerSymbol" className="input" placeholder="PTT.BK" />
        </div>
        <div>
          <label className="label">ดอกเบี้ยหน้าตั๋ว % (พันธบัตร)</label>
          <input name="couponRate" type="number" step="any" className="input" />
        </div>
        <div>
          <label className="label">วันครบกำหนด</label>
          <input name="maturityDate" type="date" className="input" />
        </div>
        <div>
          <label className="label">มูลค่าที่ตราไว้</label>
          <input name="faceValue" type="number" step="any" className="input" />
        </div>
        <BondConventionFields />
      </div>
    </ActionForm>
  );
}

export function AddPriceForm({ assets, symbol }: { assets: Asset[]; symbol?: string }) {
  return (
    <ActionForm action={addPriceAction} className="grid items-end gap-3 sm:grid-cols-4" resetOnSuccess={false}>
      <div>
        <label className="label">สินทรัพย์</label>
        <select name="symbol" className="input" defaultValue={symbol}>
          {assets.map((a) => (
            <option key={a.id}>{a.symbol}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">วันที่</label>
        <input name="date" type="date" className="input" defaultValue={today()} />
      </div>
      <div>
        <label className="label">ราคาปิด / NAV</label>
        <input name="close" type="number" step="any" className="input" required />
      </div>
    </ActionForm>
  );
}

/** Bond coupon frequency and day count (from the bond's terms / ThaiBMA). */
export function BondConventionFields({ frequency, dayCount }: { frequency?: number | null; dayCount?: string | null }) {
  return (
    <>
      <div>
        <label className="label">จ่ายดอกเบี้ย (พันธบัตร)</label>
        <select name="couponFrequency" className="input" defaultValue={frequency ?? ""}>
          <option value="">ไม่ระบุ (สมมติทุก 6 เดือน)</option>
          <option value="1">ปีละครั้ง</option>
          <option value="2">ทุก 6 เดือน</option>
          <option value="4">ทุกไตรมาส</option>
          <option value="12">ทุกเดือน</option>
        </select>
      </div>
      <div>
        <label className="label">Day count (พันธบัตร)</label>
        <select name="dayCount" className="input" defaultValue={dayCount ?? ""}>
          <option value="">ไม่ระบุ (สมมติ ACT/ACT-ICMA)</option>
          <option value="ACT/ACT-ICMA">ACT/ACT (ICMA)</option>
          <option value="ACT/365F">ACT/365 Fixed</option>
          <option value="ACT/360">ACT/360</option>
          <option value="30/360">30/360</option>
        </select>
      </div>
    </>
  );
}
