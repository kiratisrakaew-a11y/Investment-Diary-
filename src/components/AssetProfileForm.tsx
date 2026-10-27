"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Issuer and sector (with source and date) used for exposure limits and stress groupings. */
export function AssetProfileForm({ symbol, issuer, sector, sectorSource, sectorAsOf, today }: { symbol: string; issuer: string | null; sector: string | null; sectorSource: string | null; sectorAsOf: string | null; today: string }) {
  const router = useRouter();
  const [f, setF] = useState({ issuer: issuer ?? "", sector: sector ?? "", sectorSource: sectorSource ?? "", sectorAsOf: sectorAsOf ?? today });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    setMsg(null);
    const sec = f.sector.trim();
    const r = await fetch("/api/v1/assets/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, issuer: f.issuer.trim() || null, sector: sec || null, sectorSource: sec ? f.sectorSource : null, sectorAsOf: sec ? f.sectorAsOf : null }),
    });
    const data = await r.json();
    if (!r.ok) return setMsg({ ok: false, text: data.error ?? data.issues?.map((i: { message: string }) => i.message).join(", ") ?? `HTTP ${r.status}` });
    setMsg({ ok: true, text: "บันทึกแล้ว" });
    router.refresh();
  }
  const field = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} {...props} />
    </label>
  );
  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-4">
        {field("issuer", "ผู้ออก (issuer)", { placeholder: "เช่น PTT" })}
        {field("sector", "หมวด / อุตสาหกรรม", { placeholder: "เช่น Energy" })}
        {field("sectorSource", "ที่มาของการจัดหมวด", { placeholder: "เช่น SET industry group" })}
        {field("sectorAsOf", "ณ วันที่", { type: "date" })}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn" onClick={save}>บันทึก</button>
        {msg && <span className={`text-sm ${msg.ok ? "text-pos" : "text-neg"}`}>{msg.text}</span>}
      </div>
      <p className="text-xs text-muted">ใช้จำกัดน้ำหนักต่อผู้ออก/หมวดในหน้าจัดพอร์ต และสรุปการกระจุกตัวใน stress test · ระบบไม่จัดหมวดให้เอง</p>
    </div>
  );
}
