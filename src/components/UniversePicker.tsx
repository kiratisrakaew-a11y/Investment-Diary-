"use client";

/**
 * spec-mpt-selected-universe: which assets the optimizer page uses. The choice is written to ?sel= (after a short
 * debounce) and the server recomputes μ / Σ / β, the period, frequency and warnings from the checked set only.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { selectionToQuery } from "@/lib/finance/universe-selection";

export interface CatalogAsset {
  symbol: string;
  name: string;
  assetClassLabel: string;
  held: boolean;
}

export function UniversePicker({
  catalog,
  selected,
  skipped = [],
}: {
  catalog: CatalogAsset[];
  selected: string[];
  /** Selected assets the loader could not use, with the reason. */
  skipped?: { symbol: string; reason: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [draft, setDraft] = useState<string[]>(selected);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = selected.join(",");
  // A new server selection (navigation) replaces the draft.
  useEffect(() => setDraft(selected), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (next: string[]) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const q = new URLSearchParams(params?.toString() ?? "");
      q.set("sel", selectionToQuery(next));
      q.delete("ack");
      start(() => router.replace(`${pathname}?${q.toString()}`, { scroll: false }));
    }, 500);
  };
  const toggle = (s: string) => apply(draft.includes(s) ? draft.filter((x) => x !== s) : catalog.map((c) => c.symbol).filter((x) => x === s || draft.includes(x)));
  const reason = new Map(skipped.map((s) => [s.symbol, s.reason]));

  return (
    <details className="text-sm" open data-testid="universe-picker">
      <summary className="cursor-pointer text-xs text-muted">
        สินทรัพย์ที่ใช้คำนวณ: <b className="text-text">{draft.length}</b> / {catalog.length} ตัว
        {pending && <span className="ml-2">กำลังคำนวณใหม่…</span>}
      </summary>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <button type="button" className="btn-ghost py-0.5" onClick={() => apply(catalog.map((c) => c.symbol))}>
          เลือกทั้งหมด
        </button>
        <button type="button" className="btn-ghost py-0.5" onClick={() => apply([])}>
          ล้าง
        </button>
      </div>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {catalog.map((c) => {
          const on = draft.includes(c.symbol);
          return (
            <li key={c.symbol} className={on ? "" : "opacity-50"}>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={on} onChange={() => toggle(c.symbol)} data-symbol={c.symbol} />
                <span>
                  <span className="font-medium">{c.symbol}</span> <span className="text-xs text-muted">{c.assetClassLabel}</span>
                  {c.held && <span className="ml-1 text-xs text-accent">ถืออยู่</span>}
                  {on && reason.has(c.symbol) && <span className="block text-xs text-warn">ไม่ได้ใช้: {reason.get(c.symbol)}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
