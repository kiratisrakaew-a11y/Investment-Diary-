"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Government zero curve for spread analytics (source and date required). */
export function YieldCurveForm({ initial, today }: { initial: { points: { years: number; rate: number }[]; source: string; asOf: string } | null; today: string }) {
  const router = useRouter();
  const [points, setPoints] = useState(initial ? initial.points.map((p) => `${p.years}:${+(p.rate * 100).toFixed(4)}`).join(", ") : "");
  const [source, setSource] = useState(initial?.source ?? "");
  const [asOf, setAsOf] = useState(initial?.asOf ?? today);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function send(clear: boolean) {
    setMsg(null);
    const body = clear
      ? { clear: true }
      : {
          points: points
            .split(",")
            .map((x) => x.split(":").map((y) => Number(y.trim())))
            .filter((x) => x.length === 2 && x.every(Number.isFinite))
            .map(([years, rate]) => ({ years, rate: rate / 100 })),
          source,
          asOf,
        };
    const r = await fetch("/api/v1/settings/yield-curve", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) return setMsg({ ok: false, text: data.error ?? data.issues?.map((i: { message: string }) => i.message).join(", ") ?? `HTTP ${r.status}` });
    setMsg({ ok: true, text: clear ? "ล้างแล้ว" : "บันทึกแล้ว" });
    router.refresh();
  }
  return (
    <div className="space-y-2">
      <label className="block">
        <span className="label">Zero rate (ปี:% ทบต้นรายปี)</span>
        <input className="input" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="1:1.9, 2:2.0, 5:2.3, 10:2.7" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <input className="input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="แหล่งที่มา เช่น ThaiBMA zero curve" />
        <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn" onClick={() => send(false)}>บันทึก yield curve</button>
        <button type="button" className="btn-ghost text-xs" onClick={() => send(true)}>ล้าง</button>
        {msg && <span className={`text-sm ${msg.ok ? "text-pos" : "text-neg"}`}>{msg.text}</span>}
      </div>
      <p className="text-xs text-muted">ใช้คำนวณ Z-spread, spread DV01 และ spread duration ของพันธบัตรในพอร์ต · ไม่มี curve = ค่าเหล่านี้ไม่แสดง (ไม่เดา)</p>
    </div>
  );
}
