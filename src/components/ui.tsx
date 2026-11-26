import clsx from "clsx";
import { ExplainButton, type ExplainSpec } from "./ExplainButton";
import { formatChange } from "@/lib/format";
import { EmptyIcon, StatusIcon } from "./icons";

export type Tone = "orange" | "blue" | "green" | "yellow" | "purple" | "red";
const TONE_VAR: Record<Tone, string> = {
  orange: "var(--accent)",
  blue: "var(--info)",
  green: "var(--pos)",
  yellow: "var(--warn)",
  purple: "var(--series-5)",
  red: "var(--neg)",
};

/** Circular gauge; `value` 0..1 fills the ring, null draws a plain ring (no implied progress). */
export function Ring({ value, color = "orange", children, size = 48, className }: { value?: number | null; color?: Tone; children?: React.ReactNode; size?: number; className?: string }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const v = value == null || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value));
  return (
    <div className={clsx("relative grid shrink-0 place-items-center", className)} style={{ width: size, height: size, color: TONE_VAR[color] }}>
      <svg viewBox="0 0 48 48" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeOpacity={0.22} strokeWidth="4" />
        {v != null && <circle cx="24" cy="24" r={r} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${v * c} ${c}`} style={{ filter: "drop-shadow(0 0 4px currentColor)" }} />}
      </svg>
      <div className="relative text-xs font-semibold">{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  hint,
  tone,
  color,
  ring,
  ringLabel,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  hint?: string;
  /** Text colour class for the value (e.g. signClass). */
  tone?: string;
  /** Accent of the gauge; omit for a plain card. */
  color?: Tone;
  /** 0..1 fill of the gauge; only pass a real proportion. */
  ring?: number | null;
  ringLabel?: React.ReactNode;
}) {
  return (
    <div
      className="card relative overflow-hidden"
      title={hint}
      style={color ? { backgroundImage: `radial-gradient(circle at 0% 0%, color-mix(in srgb, ${TONE_VAR[color]} 30%, transparent), transparent 70%)` } : undefined}
    >
      {color && <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${TONE_VAR[color]}, transparent)` }} />}
      <div className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-2 flex items-center gap-3">
        {color && (
          <Ring value={ring} color={color} className="hidden sm:grid">
            {ringLabel}
          </Ring>
        )}
        <div className="min-w-0">
          <div className={clsx("text-xl leading-tight font-semibold break-words tabular-nums sm:text-xl", tone)}>{value}</div>
          {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export function Section({
  title,
  subtitle,
  action,
  explain,
  children,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  /** Adds the "อธิบาย" button: AI explains these values in plain language. */
  explain?: ExplainSpec;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("card", className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {explain && <ExplainButton topic={title} data={explain.data} hint={explain.hint} />}
          {action}
        </div>
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, action, explain }: { title: string; subtitle?: string; action?: React.ReactNode; explain?: ExplainSpec & { topic?: string } }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-panel px-5 py-4">
      <div className="min-w-0">
        <h1 className="text-xl leading-tight font-semibold tracking-wide">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {explain && <ExplainButton topic={explain.topic ?? title} data={explain.data} hint={explain.hint} label="อธิบายหน้านี้" />}
        {action}
      </div>
    </div>
  );
}

export type BadgeStatus = "green" | "yellow" | "red" | "info" | "neutral";
const BADGE_STYLE: Record<BadgeStatus, { cls: string; label: string }> = {
  green: { cls: "border-positive/40 bg-positive/10 text-positive", label: "ปกติ" },
  yellow: { cls: "border-warning/40 bg-warning/10 text-warning", label: "เฝ้าระวัง" },
  red: { cls: "border-negative/40 bg-negative/10 text-negative", label: "ผิดปกติ" },
  info: { cls: "border-primary/40 bg-primary/10 text-primary", label: "ข้อมูล" },
  neutral: { cls: "border-border bg-panel-2 text-text-muted", label: "" },
};
/**
 * Status / category chip. `status` adds an icon so colour is never the only signal
 * (CheckCircle / Warning / XCircle, filled).
 */
export function Badge({ children, className, title, status = "neutral" }: { children: React.ReactNode; className?: string; title?: string; status?: BadgeStatus }) {
  const st = BADGE_STYLE[status];
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", st.cls, className)}>
      {status !== "neutral" && <StatusIcon status={status} />}
      {st.label && <span className="sr-only">{st.label}: </span>}
      {children}
    </span>
  );
}

/** Plain card surface (12px radius, one shadow level). */
export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx("card", className)}>{children}</div>;
}

/**
 * KPI tile: muted label, large value, optional change (▲▼ + colour via formatChange) and note.
 * `change` is a fraction for kind "percent" (0.012 → ▲ +1.2%).
 */
export function KpiCard({
  label,
  value,
  change,
  changeKind = "percent",
  changeLabel,
  note,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  change?: number | null;
  changeKind?: "percent" | "number" | "money";
  changeLabel?: string;
  note?: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  const ch = change === undefined ? null : formatChange(change, changeKind);
  return (
    <div className={clsx("card", className)} title={hint}>
      <div className="text-sm text-text-muted">{label}</div>
      <div className="mt-1 text-2xl leading-tight font-semibold break-words tabular-nums">{value}</div>
      {(ch || note) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs">
          {ch && (
            <span className={clsx("font-medium tabular-nums", ch.className)}>
              {ch.text}
              {changeLabel && <span className="ml-1 font-normal text-text-muted">{changeLabel}</span>}
            </span>
          )}
          {note && <span className="text-text-muted">{note}</span>}
        </div>
      )}
    </div>
  );
}

/** Loading placeholder; pulse stops under prefers-reduced-motion. */
export function Skeleton({ className, lines }: { className?: string; lines?: number }) {
  if (lines && lines > 1)
    return (
      <div className="space-y-2" aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={clsx("h-4 animate-pulse rounded-md bg-panel-2", i === lines - 1 && "w-2/3", className)} />
        ))}
      </div>
    );
  return <div aria-hidden className={clsx("animate-pulse rounded-md bg-panel-2", className ?? "h-4")} />;
}

/** Nothing here yet: say what to do next (action = a button / link). Icon is 48–64px duotone (default Tray; pass <EmptyIcon icon={…} />). */
export function EmptyState({ title, description, action, icon, className }: { title: string; description?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-8 text-center", className)}>
      <div className="mb-1">{icon ?? <EmptyIcon />}</div>
      <div className="text-base font-medium">{title}</div>
      {description && <p className="max-w-md text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Something failed: a sentence a person can act on (never a raw stack / code). */
export function ErrorState({ title = "เกิดข้อผิดพลาด", message, action, className }: { title?: string; message?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div role="alert" className={clsx("flex flex-col gap-1 rounded-xl border border-negative/40 bg-negative/10 px-4 py-3 text-sm", className)}>
      <div className="font-medium text-negative">
        <StatusIcon status="red" className="mr-1 inline align-text-bottom" />
        {title}
      </div>
      {message && <div className="text-text-muted">{message}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Collapsible detail block (native <details>: keyboard + screen-reader friendly, no JS). */
export function Collapsible({ title, children, defaultOpen, className, meta }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; className?: string; meta?: React.ReactNode }) {
  return (
    <details open={defaultOpen} className={clsx("group rounded-xl border border-border", className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium select-none [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-block text-text-muted transition-transform group-open:rotate-90">
            ▸
          </span>
          {title}
        </span>
        {meta && <span className="text-xs font-normal text-text-muted">{meta}</span>}
      </summary>
      <div className="border-t border-border px-4 py-3">{children}</div>
    </details>
  );
}

/** Legacy empty box (kept for existing pages; new code uses EmptyState). */
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">{children}</div>;
}
