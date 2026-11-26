"use client";

/**
 * Interactive shared components (Phase 3): Tabs, DataTable, ChartContainer.
 * Static ones (Card, KpiCard, Badge, Skeleton, EmptyState, ErrorState, Collapsible) live in ./ui.
 */
import clsx from "clsx";
import { useId, useMemo, useRef, useState } from "react";
import { ResponsiveContainer } from "recharts";
import { EmptyState, ErrorState, Skeleton } from "./ui";

/* ---------------------------------------------------------------- Tabs */
export interface TabItem {
  id: string;
  label: React.ReactNode;
  content: React.ReactNode;
  /** Small count / status shown after the label. */
  badge?: React.ReactNode;
}

export function Tabs({ tabs, defaultId, ariaLabel, className }: { tabs: TabItem[]; defaultId?: string; ariaLabel: string; className?: string }) {
  const [active, setActive] = useState(defaultId ?? tabs[0]?.id);
  const uid = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (idx: number) => {
    const t = tabs[(idx + tabs.length) % tabs.length];
    setActive(t.id);
    refs.current[t.id]?.focus();
  };
  return (
    <div className={className}>
      <div role="tablist" aria-label={ariaLabel} className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${uid}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => {
                const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
                if (to == null) return;
                e.preventDefault();
                move(to);
              }}
              className={clsx("-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors", on ? "border-primary text-primary" : "border-transparent text-text-muted hover:text-text")}
            >
              {t.label}
              {t.badge != null && <span className="rounded-full bg-panel-2 px-2 text-xs text-text-muted">{t.badge}</span>}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`${uid}-panel-${t.id}`} aria-labelledby={`${uid}-tab-${t.id}`} hidden={t.id !== active} className="pt-4">
          {t.id === active && t.content}
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- DataTable */
export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Unit goes in the header ("ล้านบาท"), not in every cell. */
  unit?: string;
  /** Numbers: right-aligned + tabular-nums. */
  numeric?: boolean;
  render: (row: T) => React.ReactNode;
  /** Sort key; omit to make the column unsortable. */
  sortValue?: (row: T) => number | string | null | undefined;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  maxHeight,
  loading,
  error,
  empty,
  caption,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string | number;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /** Scroll area height (px or CSS); the header stays sticky inside it. */
  maxHeight?: number | string;
  loading?: boolean;
  error?: React.ReactNode;
  empty?: { title: string; description?: React.ReactNode; action?: React.ReactNode };
  caption?: string;
  className?: string;
}) {
  const [sort, setSort] = useState(defaultSort);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort?.key);
    if (!col?.sortValue || !sort) return rows;
    const f = col.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    // Empty values always sort last, whatever the direction.
    return [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      const xe = x == null || (typeof x === "number" && !Number.isFinite(x));
      const ye = y == null || (typeof y === "number" && !Number.isFinite(y));
      if (xe || ye) return xe === ye ? 0 : xe ? 1 : -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "th")) * dir;
    });
  }, [rows, columns, sort]);

  if (error) return <ErrorState message={error} />;
  if (loading)
    return (
      <div className={className} aria-busy="true">
        <Skeleton lines={5} />
      </div>
    );
  if (!rows.length) return <EmptyState title={empty?.title ?? "ยังไม่มีข้อมูล"} description={empty?.description} action={empty?.action} className={className} />;

  return (
    <div className={clsx("overflow-auto rounded-xl border border-border", className)} style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const on = sort?.key === c.key;
              const sortable = !!c.sortValue;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : undefined}
                  className={clsx("sticky top-0 z-10 border-b border-border bg-panel-solid px-2 py-2 text-xs font-semibold whitespace-nowrap text-text-muted", c.numeric ? "text-right" : "text-left")}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => setSort(on && sort!.dir === "desc" ? { key: c.key, dir: "asc" } : { key: c.key, dir: "desc" })}
                      className={clsx("inline-flex items-center gap-1 hover:text-text", c.numeric && "flex-row-reverse", on && "text-text")}
                    >
                      <span>
                        {c.header}
                        {c.unit && <span className="font-normal"> ({c.unit})</span>}
                      </span>
                      <span aria-hidden className="w-3 text-center">
                        {on ? (sort!.dir === "asc" ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  ) : (
                    <>
                      {c.header}
                      {c.unit && <span className="font-normal"> ({c.unit})</span>}
                    </>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={rowKey(r, i)} className="border-b border-border/60 last:border-0 even:bg-panel-2/30 hover:bg-panel-2/60">
              {columns.map((c) => (
                <td key={c.key} className={clsx("px-2 py-2", c.numeric ? "text-right tabular-nums" : "text-left", c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------ ChartContainer */
/** Standard chart tokens: series colours come from chart-1..6; grid is faint; axes use the muted text colour. */
export const CHART = {
  colors: ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"],
  grid: { stroke: "var(--border)", strokeDasharray: "3 3", vertical: false } as const,
  axis: { stroke: "var(--text-muted)", fontSize: 12, tickLine: false, axisLine: false } as const,
  tooltip: {
    contentStyle: { background: "var(--panel-solid)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, color: "var(--text)" },
    labelStyle: { color: "var(--text-muted)" },
  },
} as const;

/** Frame for a Recharts chart: title, loading / empty / error states, fixed height. Format tooltips with the number helpers. */
export function ChartContainer({
  title,
  subtitle,
  action,
  height = 280,
  loading,
  error,
  empty,
  children,
  className,
}: {
  title?: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  height?: number;
  loading?: boolean;
  error?: React.ReactNode;
  /** Pass the empty-state copy when there is nothing to draw. */
  empty?: { title: string; description?: React.ReactNode; action?: React.ReactNode } | false;
  children: React.ReactElement;
  className?: string;
}) {
  return (
    <section className={clsx("card", className)}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-text-muted">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div style={{ minHeight: height }}>
        {error ? (
          <ErrorState message={error} />
        ) : loading ? (
          <div style={{ height }} aria-busy="true">
            <Skeleton className="h-full w-full" />
          </div>
        ) : empty ? (
          <EmptyState title={empty.title} description={empty.description} action={empty.action} />
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            {children}
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
