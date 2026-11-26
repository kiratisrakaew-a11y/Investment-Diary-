"use client";

/**
 * spec-lookback-window: choose the data period (1Y … Max / custom dates, optional analysis date and a separate
 * period for expected returns). mode "query" writes ?win=…&from=…&to=…&mu=… (server pages reload);
 * mode "state" reports the choice through onChange (client panels).
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { WindowPreset, WindowRequest } from "@/lib/finance/window";
import { fmtNum } from "@/lib/format";

export interface WindowValue {
  preset: WindowPreset;
  startDate?: string;
  endDate?: string;
  muPreset?: WindowPreset;
}

const PRESETS: { value: WindowPreset; label: string }[] = [
  { value: "1y", label: "1 ปี" },
  { value: "2y", label: "2 ปี" },
  { value: "3y", label: "3 ปี" },
  { value: "5y", label: "5 ปี" },
  { value: "7y", label: "7 ปี" },
  { value: "10y", label: "10 ปี" },
  { value: "max", label: "ทั้งหมด (Max)" },
  { value: "custom", label: "กำหนดเอง" },
];

/** The request body / MCP shape of a picker value. */
export function windowRequestOf(v: WindowValue): WindowRequest {
  return {
    preset: v.preset,
    ...(v.preset === "custom" && v.startDate ? { startDate: v.startDate } : {}),
    ...(v.endDate ? { endDate: v.endDate } : {}),
    ...(v.muPreset ? { muWindow: { preset: v.muPreset } } : {}),
  };
}

export function WindowPicker({
  value,
  mode = "state",
  onChange,
  showMu = true,
  className,
}: {
  value: WindowValue;
  mode?: "query" | "state";
  onChange?: (v: WindowValue) => void;
  /** Offer the advanced separate period for expected returns. */
  showMu?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [advanced, setAdvanced] = useState(!!value.muPreset || !!value.endDate);
  const [draft, setDraft] = useState(value);

  const set = (next: WindowValue) => {
    setDraft(next);
    // A custom period waits for its start date.
    if (next.preset === "custom" && !next.startDate) return;
    if (mode === "query") {
      const q = new URLSearchParams(params?.toString() ?? "");
      q.set("win", next.preset);
      for (const [k, v] of [
        ["from", next.preset === "custom" ? next.startDate : undefined],
        ["to", next.endDate],
        ["mu", next.muPreset],
      ] as const)
        if (v) q.set(k, v);
        else q.delete(k);
      start(() => router.replace(`${pathname}?${q.toString()}`, { scroll: false }));
    }
    onChange?.(next);
  };

  return (
    <div className={`flex flex-wrap items-end gap-3 text-sm ${className ?? ""}`} data-testid="window-picker">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">ช่วงข้อมูล</span>
        <select className="input py-1" name="windowPreset" value={draft.preset} disabled={pending} onChange={(e) => set({ ...draft, preset: e.target.value as WindowPreset })}>
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {draft.preset === "custom" && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">เริ่ม</span>
          <input type="date" className="input py-1" name="windowStart" value={draft.startDate ?? ""} onChange={(e) => set({ ...draft, startDate: e.target.value || undefined })} />
        </label>
      )}
      {advanced && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">ณ วันที่ (ว่าง = ล่าสุด)</span>
            <input type="date" className="input py-1" name="windowEnd" value={draft.endDate ?? ""} onChange={(e) => set({ ...draft, endDate: e.target.value || undefined })} />
          </label>
          {showMu && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">ช่วงสำหรับผลตอบแทนคาดหวัง</span>
              <select className="input py-1" name="muPreset" value={draft.muPreset ?? ""} onChange={(e) => set({ ...draft, muPreset: (e.target.value || undefined) as WindowPreset | undefined })}>
                <option value="">เหมือนช่วงข้อมูล</option>
                {PRESETS.filter((p) => p.value !== "custom").map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      <button type="button" className="btn-ghost py-1 text-xs" onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "ซ่อนตัวเลือกขั้นสูง" : "ขั้นสูง"}
      </button>
      {pending && <span className="text-xs text-muted">กำลังคำนวณใหม่…</span>}
    </div>
  );
}

/** "ขอ 3 ปี · ใช้จริง 1.1 ปี (56 สัปดาห์) เพราะ MRDIYT เริ่ม 2025-11-09" with the quality badge. */
export function WindowBanner({
  info,
}: {
  info?: {
    requested: { preset: string; startDate: string | null; endDate: string };
    effective: { startDate: string; endDate: string; observations: number; frequency: string; years: number } | null;
    limitedBy: { symbol: string; firstDate: string }[];
    quality: "ok" | "thin" | "insufficient";
    obsPerAsset: number;
    muYears: number;
    sigmaYears: number;
  } | null;
}) {
  if (!info) return null;
  const reqYears = info.requested.startDate ? (Date.parse(info.requested.endDate) - Date.parse(info.requested.startDate)) / (365.25 * 86_400_000) : null;
  const e = info.effective;
  const unit = e?.frequency === "weekly" ? "สัปดาห์" : e?.frequency === "monthly" ? "เดือน" : "วัน";
  const tone = info.quality === "ok" ? "bg-pos/10 text-pos" : info.quality === "thin" ? "bg-warn/10 text-warn" : "bg-neg/10 text-neg";
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="window-banner">
      <span className={`rounded-md px-1.5 py-0.5 font-medium ${tone}`}>{info.quality}</span>
      <span>
        ขอ {info.requested.preset === "max" ? "ทั้งหมด" : reqYears != null ? `${fmtNum(reqYears, 1)} ปี` : info.requested.preset}
        {e ? ` · ใช้จริง ${fmtNum(e.years, 1)} ปี (${e.observations} ${unit}, ${e.startDate} → ${e.endDate})` : " · ใช้ไม่ได้"}
        {info.limitedBy.length ? ` เพราะ ${info.limitedBy.map((l) => `${l.symbol} เริ่ม ${l.firstDate}`).join(", ")}` : ""}
        {` · ${fmtNum(info.obsPerAsset, 1)} งวด/สินทรัพย์`}
        {Math.abs(info.muYears - info.sigmaYears) > 0.05 ? ` · μ จาก ${fmtNum(info.muYears, 1)} ปี, Σ จาก ${fmtNum(info.sigmaYears, 1)} ปี` : ""}
      </span>
    </p>
  );
}
