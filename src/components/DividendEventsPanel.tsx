"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtNum } from "@/lib/format";
import { NumField, SelectField } from "./fields";
import { Badge } from "./ui";

type Event = {
  id: number;
  symbol: string;
  exDate: string | null;
  paymentDate: string | null;
  declarationDate: string | null;
  announcedAt: string | null;
  dividendPerShare: number;
  currency: string;
  cashOrStock: string;
  kind: string;
  source: string;
  dataQualityStatus: string;
  revisions: unknown[];
};

const KIND: Record<string, string> = { regular: "ปกติ", special: "พิเศษ", indicated_annual: "อัตราต่อปีที่ประกาศ", unknown: "ไม่ระบุ" };

/** Issuer dividend events: add from announcements, import Yahoo history, delete. Never touches the ledger. */
export function DividendEventsPanel({ events, symbols }: { events: Event[]; symbols: string[] }) {
  const router = useRouter();
  const [f, setF] = useState({ symbol: symbols[0] ?? "", exDate: "", paymentDate: "", declarationDate: "", recordDate: "", dps: null as number | null, currency: "THB", kind: "regular", cashOrStock: "cash", source: "", wht: null as number | null });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState("");

  const call = async (url: string, init: RequestInit) => {
    setPending(true);
    setMsg(null);
    try {
      const r = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? data.issues?.map((i: { message: string }) => i.message).join(", ") ?? `HTTP ${r.status}`);
      router.refresh();
      return data;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      setPending(false);
    }
  };

  async function save() {
    const d = await call("/api/v1/dividends/events", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            symbol: f.symbol,
            exDate: f.exDate || null,
            paymentDate: f.paymentDate || null,
            declarationDate: f.declarationDate || null,
            recordDate: f.recordDate || null,
            dividendPerShare: f.dps,
            currency: f.currency,
            kind: f.kind,
            cashOrStock: f.cashOrStock,
            source: f.source,
            withholdingTaxRate: f.wht,
            dataQualityStatus: "unverified",
          },
        ],
      }),
    });
    if (d) setMsg({ ok: true, text: `บันทึกแล้ว (ใหม่ ${d.inserted} · แก้ไข ${d.updated} · ไม่เปลี่ยน ${d.unchanged})` });
  }
  async function importYahoo() {
    const d = await call("/api/v1/dividends/import", { method: "POST", body: "{}" });
    if (d) setMsg({ ok: !d.results.some((r: { status: string }) => r.status === "error"), text: d.results.map((r: { symbol: string; status: string; inserted?: number; message?: string }) => `${r.symbol}: ${r.status === "ok" ? `+${r.inserted}` : r.message}`).join(" · ") || "ไม่มีหุ้นที่ดึงราคาจาก Yahoo" });
  }
  async function remove(id: number) {
    if (!confirm("ลบเหตุการณ์ปันผลนี้? (ไม่กระทบรายการรับเงินในบัญชี)")) return;
    await call(`/api/v1/dividends/events?id=${id}`, { method: "DELETE" });
  }

  const shown = events.filter((e) => !filter || e.symbol === filter).slice().reverse();
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        ข้อมูลประกาศจ่ายปันผลของบริษัท (ex-date / วันจ่าย / ปันผลต่อหุ้น) — แยกจาก “รายการรับปันผล” ในบัญชี · ไม่รู้วันไหนให้เว้นว่าง ระบบไม่เดาให้ · ปันผลต่อหุ้นใส่ตามฐานหุ้น ณ วัน XD (ระบบปรับตาม split ที่บันทึกไว้)
      </p>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SelectField label="หุ้น" value={f.symbol} onChange={(v) => setF({ ...f, symbol: v })} options={symbols.map((s) => ({ value: s, label: s }))} />
        {(
          [
            ["exDate", "ex-date (XD)"],
            ["paymentDate", "วันจ่าย"],
            ["declarationDate", "วันประกาศ"],
            ["recordDate", "วันปิดสมุด"],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="block">
            <span className="label">{label}</span>
            <input type="date" className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
        <NumField label="ปันผลต่อหุ้น" value={f.dps} onChange={(v) => setF({ ...f, dps: v })} />
        <SelectField label="สกุลเงิน" value={f.currency} onChange={(v) => setF({ ...f, currency: v })} options={[{ value: "THB", label: "THB" }, { value: "USD", label: "USD" }]} />
        <SelectField label="ประเภท" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} />
        <SelectField label="เงินสด/หุ้น" value={f.cashOrStock} onChange={(v) => setF({ ...f, cashOrStock: v })} options={[{ value: "cash", label: "เงินสด" }, { value: "stock", label: "หุ้นปันผล" }]} />
        <NumField label="ภาษีหัก ณ ที่จ่าย" pct nullable value={f.wht} onChange={(v) => setF({ ...f, wht: v })} />
        <label className="block sm:col-span-2">
          <span className="label">แหล่งข้อมูล (จำเป็น)</span>
          <input className="input" placeholder="เช่น ประกาศ SET 2026-02-20 หรือ URL" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" disabled={pending || !f.symbol || !f.dps || !f.source} onClick={save}>
          บันทึกเหตุการณ์ปันผล
        </button>
        <button className="btn-ghost" disabled={pending} onClick={importYahoo}>
          ดึงประวัติปันผลจาก Yahoo
        </button>
        {msg && <span className={msg.ok ? "text-xs text-pos" : "text-xs text-neg"}>{msg.text}</span>}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">แสดง</span>
        <select className="input w-auto py-1 text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">ทุกหุ้น ({events.length})</option>
          {[...new Set(events.map((e) => e.symbol))].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>หุ้น</th>
              <th>ex-date</th>
              <th>วันจ่าย</th>
              <th>ประกาศ</th>
              <th className="num">ต่อหุ้น</th>
              <th>ประเภท</th>
              <th>แหล่ง</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id}>
                <td className="font-medium">{e.symbol}</td>
                <td>{e.exDate ?? <span className="text-muted">ไม่ทราบ</span>}</td>
                <td>{e.paymentDate ?? <span className="text-muted">ไม่ทราบ</span>}</td>
                <td>{e.announcedAt ?? <span className="text-muted">–</span>}</td>
                <td className="num">
                  {fmtNum(e.dividendPerShare, 4)} {e.currency}
                </td>
                <td>
                  <Badge>{KIND[e.kind] ?? e.kind}</Badge> {e.cashOrStock === "stock" && <Badge>หุ้น</Badge>}
                  {e.revisions.length > 0 && <Badge className="ml-1">แก้ไข {e.revisions.length}</Badge>}
                </td>
                <td className="max-w-48 truncate text-xs text-muted" title={e.source}>
                  {e.source} · {e.dataQualityStatus}
                </td>
                <td>
                  <button className="text-xs text-muted hover:text-neg" onClick={() => remove(e.id)} disabled={pending}>
                    ลบ
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="p-4 text-center text-sm text-muted">ยังไม่มีเหตุการณ์ปันผล — บันทึกจากประกาศ SET หรือดึงจาก Yahoo</p>}
      </div>
    </div>
  );
}
