"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  LINE_ITEM_GROUPS,
  LINE_ITEM_LABEL,
  assumptionsFromHistory,
  avg,
  deriveRatios,
  emptyYear,
  revenueCagr,
  type FinancialYear,
  type HistoryAssumptions,
  type LineItem,
  type YearRatios,
} from "@/lib/financials";
import { deleteStatementYearAction, loadStatementsAction, saveStatementYearAction } from "@/app/(app)/valuation/actions";
import { fmtNum, fmtPct } from "@/lib/format";

const MAX_BYTES = 4.5 * 1024 * 1024;
const ACCEPT = ".pdf,.xlsx,.csv";

type QueueItem = { id: number; name: string; size: number; status: "waiting" | "reading" | "done" | "error"; message?: string };

export interface StatementsData {
  years: FinancialYear[];
  sources: Record<number, string | null>;
  uploads: { id: number; filename: string; status: string; yearsFound: number[]; notes: string; error: string | null }[];
}

const RATIO_ROWS: [string, keyof YearRatios][] = [
  ["Revenue growth", "revenueGrowth"],
  ["Gross margin", "grossMargin"],
  ["EBIT margin", "ebitMargin"],
  ["Net margin", "netMargin"],
  ["D&A / รายได้", "daPct"],
  ["Capex / รายได้", "capexPct"],
  ["NWC / รายได้", "nwcPct"],
  ["อัตราภาษีที่แท้จริง", "effectiveTax"],
  ["ROE", "roe"],
  ["Payout ratio", "payout"],
  ["ต้นทุนหนี้", "costOfDebt"],
];

export function FinancialStatementsPanel({
  symbol,
  initial,
  terminalGrowth,
  onApply,
}: {
  symbol: string;
  initial: StatementsData;
  terminalGrowth: number;
  onApply: (a: HistoryAssumptions) => void;
}) {
  const [data, setData] = useState<StatementsData>(initial);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [applied, setApplied] = useState<string[] | null>(null);
  const [open, setOpen] = useState(initial.years.length > 0);
  const busy = useRef(false);
  const nextId = useRef(1);
  const pending = useRef<{ id: number; file: File }[]>([]);
  const loadedFor = useRef(symbol);

  // Reload when the editor switches to another company.
  useEffect(() => {
    if (!symbol || loadedFor.current === symbol) return;
    loadedFor.current = symbol;
    setApplied(null);
    loadStatementsAction(symbol).then((d) => setData(d as StatementsData));
  }, [symbol]);

  const refresh = async () => setData((await loadStatementsAction(symbol)) as StatementsData);

  async function pump() {
    if (busy.current) return;
    busy.current = true;
    while (pending.current.length) {
      const { id, file } = pending.current.shift()!;
      setQueue((q) => q.map((x) => (x.id === id ? { ...x, status: "reading" } : x)));
      try {
        const fd = new FormData();
        fd.append("symbol", symbol);
        fd.append("file", file);
        const res = await fetch("/api/statements/upload", { method: "POST", body: fd });
        const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        const yrs = (body.yearsFound as number[]).sort();
        setQueue((q) =>
          q.map((x) =>
            x.id === id ? { ...x, status: "done", message: `ปี ${yrs.join(", ")} · หน่วย ${body.unit}${body.basis === "separate" ? " · ⚠️ งบเฉพาะกิจการ" : ""}` } : x,
          ),
        );
        await refresh();
      } catch (e) {
        setQueue((q) => q.map((x) => (x.id === id ? { ...x, status: "error", message: (e as Error).message } : x)));
      }
    }
    busy.current = false;
  }

  function addFiles(files: FileList | File[]) {
    if (!symbol) return alert("ระบุสินทรัพย์ก่อนอัปโหลด");
    setOpen(true);
    const items: QueueItem[] = [];
    for (const f of Array.from(files)) {
      const id = nextId.current++;
      const ext = f.name.toLowerCase().split(".").pop();
      if (!["pdf", "xlsx", "csv"].includes(ext ?? "")) {
        items.push({ id, name: f.name, size: f.size, status: "error", message: ext === "xls" ? "ไฟล์ .xls ให้บันทึกเป็น .xlsx ก่อน" : "รองรับ PDF, .xlsx, .csv" });
      } else if (f.size > MAX_BYTES) {
        items.push({ id, name: f.name, size: f.size, status: "error", message: "ใหญ่เกิน 4.5MB — ตัดเฉพาะหน้างบการเงิน" });
      } else {
        items.push({ id, name: f.name, size: f.size, status: "waiting" });
        pending.current.push({ id, file: f });
      }
    }
    setQueue((q) => [...q, ...items]);
    void pump();
  }

  const sorted = [...data.years].sort((a, b) => a.fiscalYear - b.fiscalYear);
  const visible = showAll ? sorted : sorted.slice(-5);
  const ratios = deriveRatios(sorted);
  const ratioOf = (fy: number) => ratios.find((r) => r.fiscalYear === fy);
  const cagr = revenueCagr(sorted.slice(-5));

  async function editCell(fy: number, key: LineItem, value: number | null) {
    const y = { ...(sorted.find((s) => s.fiscalYear === fy) ?? emptyYear(fy)), [key]: value };
    setData((d) => ({ ...d, years: d.years.map((x) => (x.fiscalYear === fy ? y : x)) }));
    await saveStatementYearAction(symbol, y);
  }

  async function addYear() {
    const latest = sorted[sorted.length - 1]?.fiscalYear;
    const fy = Number(prompt("ปีบัญชี (ค.ศ.)", String(latest ? latest + 1 : new Date().getFullYear() - 1)));
    if (!Number.isInteger(fy) || fy < 1990 || fy > 2100 || sorted.some((s) => s.fiscalYear === fy)) return;
    const y = emptyYear(fy);
    setData((d) => ({ ...d, years: [...d.years, y] }));
    await saveStatementYearAction(symbol, y);
  }

  async function removeYear(fy: number) {
    if (!confirm(`ลบข้อมูลปี ${fy}?`)) return;
    setData((d) => ({ ...d, years: d.years.filter((y) => y.fiscalYear !== fy) }));
    await deleteStatementYearAction(symbol, fy);
  }

  function apply() {
    const a = assumptionsFromHistory(sorted, terminalGrowth);
    onApply(a);
    setApplied(a.explanations);
  }

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="text-left" onClick={() => setOpen((o) => !o)}>
          <h2 className="text-[15px] font-semibold">
            {open ? "▾" : "▸"} งบการเงินย้อนหลัง {sorted.length ? `(${sorted[0].fiscalYear}–${sorted[sorted.length - 1].fiscalYear})` : ""}
          </h2>
          <p className="text-xs text-muted">อัปโหลดงบ (PDF / Excel / CSV) แยกไฟล์ได้ — AI อ่านและกรอกตัวเลขให้ หน่วย: ล้าน (ต่อหุ้นเป็นบาท)</p>
        </button>
        <div className="flex flex-wrap gap-2">
          {sorted.length > 0 && (
            <button type="button" className="btn" onClick={apply}>
              เติมสมมติฐานจากงบการเงิน
            </button>
          )}
          <a href="/financial-statements-template.csv" download className="btn-ghost text-xs">
            ดาวน์โหลดแม่แบบ CSV
          </a>
        </div>
      </div>

      {open && (
        <>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(e.dataTransfer.files);
            }}
            className={clsx(
              "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-center text-sm",
              drag ? "border-accent bg-accent/5" : "border-border",
            )}
          >
            <input
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <span className="font-medium">ลากไฟล์มาวาง หรือคลิกเพื่อเลือก</span>
            <span className="text-xs text-muted">
              PDF, .xlsx, .csv · ไม่เกิน 4.5MB ต่อไฟล์ · เลือกหลายไฟล์ได้ เช่น งบปี 2020–2024 แยกไฟล์ละปี · ระบบไม่เก็บไฟล์ต้นฉบับ
            </span>
          </label>

          {queue.length > 0 && (
            <ul className="space-y-1 text-sm">
              {queue.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center gap-2">
                  <span className={clsx("w-5 text-center", q.status === "reading" && "animate-pulse")}>
                    {q.status === "done" ? "✅" : q.status === "error" ? "⚠️" : q.status === "reading" ? "⏳" : "•"}
                  </span>
                  <span className="font-medium">{q.name}</span>
                  <span className="text-xs text-muted">{(q.size / 1024 / 1024).toFixed(2)}MB</span>
                  <span className={clsx("text-xs", q.status === "error" ? "text-neg" : "text-muted")}>
                    {q.status === "reading" ? "AI กำลังอ่าน… (อาจใช้เวลา 30–90 วินาที)" : q.status === "waiting" ? "รอคิว" : q.message}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <button type="button" className="btn-ghost text-xs" onClick={addYear}>
              + เพิ่มปี (กรอกเอง)
            </button>
            {sorted.length > 5 && (
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> แสดงทุกปี ({sorted.length})
              </label>
            )}
            {cagr != null && <span className="text-muted">CAGR รายได้ {visible.length} ปีล่าสุด: <b>{fmtPct(cagr, 1)}</b></span>}
          </div>

          {visible.length > 0 && (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="min-w-48">รายการ (ล้าน)</th>
                    {visible.map((y) => (
                      <th key={y.fiscalYear} className="num min-w-28">
                        <div className="flex items-center justify-end gap-1">
                          {y.fiscalYear}
                          <button type="button" className="text-muted hover:text-neg" title="ลบปีนี้" onClick={() => removeYear(y.fiscalYear)}>
                            ×
                          </button>
                        </div>
                        {data.sources[y.fiscalYear] && <div className="max-w-28 truncate text-[10px] font-normal" title={data.sources[y.fiscalYear]!}>{data.sources[y.fiscalYear]}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {LINE_ITEM_GROUPS.map((g) => (
                    <GroupRows key={g.title} title={g.title} items={g.items} years={visible} span={visible.length + 1} onEdit={editCell} />
                  ))}
                  <tr>
                    <td colSpan={visible.length + 1} className="pt-4 text-xs font-semibold text-muted">อัตราส่วนที่คำนวณได้</td>
                  </tr>
                  {RATIO_ROWS.map(([label, key]) => (
                    <tr key={key}>
                      <td className="text-muted">{label}</td>
                      {visible.map((y) => (
                        <td key={y.fiscalYear} className="num text-muted">
                          {fmtPct(ratioOf(y.fiscalYear)?.[key] as number | null, 1)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td className="text-muted">เฉลี่ย EBIT margin / Capex %</td>
                    <td colSpan={visible.length} className="text-right text-muted">
                      {fmtPct(avg(visible.map((y) => ratioOf(y.fiscalYear)?.ebitMargin)), 1)} / {fmtPct(avg(visible.map((y) => ratioOf(y.fiscalYear)?.capexPct)), 1)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {applied && (
            <div className="rounded-lg bg-bg p-3 text-xs">
              <div className="mb-1 font-semibold">เติมสมมติฐานแล้ว — ตรวจและปรับได้ในแบบฟอร์มด้านล่าง</div>
              <ul className="list-disc space-y-0.5 pl-5">
                {applied.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {data.uploads.some((u) => u.status === "done" && u.notes) && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">บันทึกจาก AI เกี่ยวกับแหล่งที่มาของตัวเลข</summary>
              <ul className="mt-2 space-y-1">
                {data.uploads
                  .filter((u) => u.status === "done")
                  .map((u) => (
                    <li key={u.id}>
                      <b>{u.filename}</b> ({u.yearsFound.join(", ")}): {u.notes}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function GroupRows({
  title,
  items,
  years,
  span,
  onEdit,
}: {
  title: string;
  items: LineItem[];
  years: FinancialYear[];
  span: number;
  onEdit: (fy: number, key: LineItem, v: number | null) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={span} className="pt-3 text-xs font-semibold text-muted">{title}</td>
      </tr>
      {items.map((k) => (
        <tr key={k}>
          <td>{LINE_ITEM_LABEL[k]}</td>
          {years.map((y) => (
            <td key={y.fiscalYear} className="num p-1">
              <Cell value={y[k]} onCommit={(v) => onEdit(y.fiscalYear, k, v)} perShare={k === "eps" || k === "dps"} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function Cell({ value, onCommit, perShare }: { value: number | null; onCommit: (v: number | null) => void; perShare?: boolean }) {
  const show = (v: number | null) => (v == null ? "" : perShare ? String(Number(v.toFixed(4))) : String(Number(v.toFixed(2))));
  const [text, setText] = useState(show(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-right tabular-nums hover:border-border focus:border-accent focus:outline-none"
      inputMode="decimal"
      value={focus ? text : value == null ? "" : fmtNum(value, perShare ? 2 : 0)}
      placeholder="–"
      onFocus={() => {
        setFocus(true);
        setText(show(value));
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocus(false);
        const t = text.replace(/,/g, "").trim();
        const v = t === "" ? null : Number(t);
        if (v !== null && !Number.isFinite(v)) return;
        if (v !== value) onCommit(v);
      }}
    />
  );
}
