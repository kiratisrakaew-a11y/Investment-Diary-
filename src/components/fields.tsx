"use client";

import { useEffect, useState } from "react";

/** Numeric input that keeps the user's in-progress text (e.g. "-", "1.") while editing. */
function useNumText(value: number | null | undefined, scale: number) {
  const fmt = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "" : String(Number((v * scale).toFixed(6))));
  const [text, setText] = useState(fmt(value));
  useEffect(() => {
    const parsed = Number(text);
    if (text === "" ? value != null : !Number.isFinite(parsed) || Math.abs(parsed / scale - (value ?? NaN)) > 1e-12) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return [text, setText] as const;
}

export function NumField({
  label,
  value,
  onChange,
  pct,
  step,
  hint,
  nullable,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  /** Show as percent (value is a decimal). */
  pct?: boolean;
  step?: number;
  hint?: string;
  nullable?: boolean;
}) {
  const scale = pct ? 100 : 1;
  const [text, setText] = useNumText(value, scale);
  return (
    <label className="block" title={hint}>
      <span className="label">
        {label}
        {pct && " (%)"}
      </span>
      <input
        className="input tabular-nums"
        inputMode="decimal"
        value={text}
        step={step}
        placeholder={nullable ? "อัตโนมัติ" : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") {
            if (nullable) onChange(null);
            return;
          }
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n / scale);
        }}
      />
      {pct && value != null && value !== 0 && Math.abs(value) < 0.001 && (
        <span className="mt-0.5 block text-[11px] text-neg">ช่องนี้เป็น % — ใส่ 7 สำหรับ 7% (ตอนนี้ = {(value * 100).toFixed(3)}%)</span>
      )}
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--accent)]" />
      {label}
    </label>
  );
}
