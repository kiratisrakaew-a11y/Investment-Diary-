import clsx from "clsx";

export function Stat({ label, value, sub, hint, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="card" title={hint}>
      <div className="text-xs text-muted">{label}</div>
      <div className={clsx("mt-1 text-xl font-semibold tabular-nums", tone)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Section({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("card", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={clsx("inline-block rounded-full border border-border px-2 py-0.5 text-[11px] text-muted", className)}>{children}</span>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">{children}</div>;
}
