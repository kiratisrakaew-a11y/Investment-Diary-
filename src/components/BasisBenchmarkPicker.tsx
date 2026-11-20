"use client";

/**
 * PRICE_BASIS_BENCHMARK_SPEC §5: choose the price basis (Close / Adjusted Close) and the benchmark index.
 *  - mode "query": server pages — writes ?basis=…&bench=… and the page reloads with the new values;
 *  - mode "state": client panels — reports the choice through onChange.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  BENCHMARK_KIND_LABEL,
  RETURN_BASIS_LABEL,
  type ReturnBasis,
} from "@/lib/finance/price-basis";

export interface PickerBenchmark {
  symbol: string;
  kind: "price_index" | "total_return";
  days: number;
}

export interface BasisBenchmarkValue {
  basis: ReturnBasis;
  bench: string;
}

export function BasisBenchmarkPicker({
  value,
  benchmarks,
  mode = "state",
  onChange,
  showBenchmark = true,
  showBasis = true,
  disabledBases,
  adjCoverage,
  note,
  className,
}: {
  value: BasisBenchmarkValue;
  benchmarks: PickerBenchmark[];
  mode?: "query" | "state";
  onChange?: (v: BasisBenchmarkValue) => void;
  showBenchmark?: boolean;
  showBasis?: boolean;
  /** Bases that cannot be used here, with the reason shown under the select. */
  disabledBases?: Partial<Record<ReturnBasis, string>>;
  /** Assets with complete / incomplete adjusted closes (shown when Adjusted Close is chosen). */
  adjCoverage?: { complete: number; incomplete: number; missing?: string[] };
  note?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const set = (next: BasisBenchmarkValue) => {
    if (mode === "query") {
      const q = new URLSearchParams(params?.toString() ?? "");
      q.set("basis", next.basis);
      q.set("bench", next.bench);
      start(() => router.replace(`${pathname}?${q.toString()}`, { scroll: false }));
    }
    onChange?.(next);
  };

  const disabledReason = disabledBases?.[value.basis] ?? null;
  const anyDisabled = Object.values(disabledBases ?? {}).filter(Boolean);

  return (
    <div
      className={`flex flex-wrap items-end gap-3 text-sm ${className ?? ""}`}
      data-testid="basis-benchmark-picker"
    >
      {showBasis && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">ชนิดราคา</span>
          <select
            className="input py-1"
            name="returnBasis"
            value={value.basis}
            disabled={pending}
            onChange={(e) =>
              set({ ...value, basis: e.target.value as ReturnBasis })
            }
          >
            {(["price_return", "total_return"] as const).map((b) => (
              <option key={b} value={b} disabled={!!disabledBases?.[b]}>
                {RETURN_BASIS_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
      )}
      {showBenchmark && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">ดัชนีอ้างอิง</span>
          <select
            className="input py-1"
            name="benchmark"
            value={value.bench}
            disabled={pending}
            onChange={(e) => set({ ...value, bench: e.target.value })}
          >
            <option value="default">ตามค่าเดิม</option>
            <option value="auto">อัตโนมัติ (ชนิดตรงกับราคา)</option>
            {benchmarks
              .filter((b) => b.days > 0)
              .map((b) => (
                <option key={b.symbol} value={b.symbol}>
                  {b.symbol} ({BENCHMARK_KIND_LABEL[b.kind]})
                </option>
              ))}
            {!["default", "auto"].includes(value.bench) &&
              !benchmarks.some((b) => b.symbol === value.bench) && (
                <option value={value.bench}>{value.bench} (ไม่มีข้อมูล)</option>
              )}
          </select>
        </label>
      )}
      {pending && <span className="text-xs text-muted">กำลังคำนวณใหม่…</span>}
      <div className="w-full space-y-0.5 text-xs text-muted">
        {showBasis && value.basis === "total_return" && adjCoverage && (
          <p data-testid="adj-coverage">
            ราคาปรับปันผลครบ {adjCoverage.complete} ตัว · ไม่ครบ{" "}
            {adjCoverage.incomplete} ตัว
            {adjCoverage.missing?.length
              ? ` (${adjCoverage.missing.slice(0, 8).join(", ")}${adjCoverage.missing.length > 8 ? " …" : ""})`
              : ""}
          </p>
        )}
        {disabledReason && <p className="text-neg">{disabledReason}</p>}
        {!disabledReason &&
          anyDisabled.map((r) => (
            <p key={r} data-testid="basis-disabled-reason">
              ไม่มีตัวเลือก Adjusted Close: {r}
            </p>
          ))}
        {note && <p>{note}</p>}
      </div>
    </div>
  );
}

/** "ราคา: Adjusted Close · ดัชนี: SETTRI (ผลตอบแทนรวม)" with the benchmark / basis warnings. */
export function BasisSummary({
  priceBasis,
  benchmark,
}: {
  priceBasis?: {
    used: ReturnBasis;
    fallback?: { symbol: string; reason: string }[];
    excluded?: { symbol: string; reason: string }[];
  } | null;
  benchmark?: {
    symbol: string;
    kind: "price_index" | "total_return";
    warning: string | null;
  } | null;
}) {
  if (!priceBasis && !benchmark) return null;
  const parts: string[] = [];
  if (priceBasis)
    parts.push(
      `ราคา: ${priceBasis.used === "total_return" ? "Adjusted Close" : "Close"}`,
    );
  if (benchmark)
    parts.push(
      `ดัชนี: ${benchmark.symbol} (${BENCHMARK_KIND_LABEL[benchmark.kind]})`,
    );
  return (
    <div className="space-y-0.5 text-xs" data-testid="basis-summary">
      <p className="text-muted">{parts.join(" · ")}</p>
      {benchmark?.warning && <p className="text-warn">{benchmark.warning}</p>}
      {priceBasis?.fallback?.length ? (
        <p className="text-muted">
          ใช้ราคาปิดแทน:{" "}
          {priceBasis.fallback.map((f) => `${f.symbol} (${f.reason})`).join(" · ")}
        </p>
      ) : null}
      {priceBasis?.excluded?.length ? (
        <p className="text-neg">
          ไม่ได้นำมาคำนวณ:{" "}
          {priceBasis.excluded.map((f) => `${f.symbol} (${f.reason})`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
