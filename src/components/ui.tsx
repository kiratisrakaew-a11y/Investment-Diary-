import clsx from "clsx";
import { ExplainButton, type ExplainSpec } from "./ExplainButton";

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
      <div className="relative text-[11px] font-semibold">{children}</div>
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
      <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</div>
      <div className="mt-2 flex items-center gap-3">
        {color && (
          <Ring value={ring} color={color} className="hidden sm:grid">
            {ringLabel}
          </Ring>
        )}
        <div className="min-w-0">
          <div className={clsx("text-lg font-semibold break-words tabular-nums sm:text-xl", tone)}>{value}</div>
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
        <h1 className="text-xl font-semibold tracking-wide">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {explain && <ExplainButton topic={explain.topic ?? title} data={explain.data} hint={explain.hint} label="อธิบายหน้านี้" />}
        {action}
      </div>
    </div>
  );
}

export function Badge({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-block rounded-full border border-border bg-panel-2 px-2 py-0.5 text-[11px] text-muted", className)}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">{children}</div>;
}
