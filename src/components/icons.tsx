/**
 * Icon system (DESIGN.md · Phase 3.5). One library only: Phosphor (`@phosphor-icons/react/ssr`, works in server
 * and client components). Sizes 16 / 20 / 24; weights: regular (inactive sidebar), duotone / fill (cards, active
 * sidebar item), fill for status. Icon-only controls need an accessible name + tooltip → `IconButton`.
 */
import clsx from "clsx";
import {
  ArrowsLeftRight,
  Calculator,
  CalendarStar,
  Certificate,
  ChartBar,
  ChartLineUp,
  ChartPieSlice,
  CheckCircle,
  ClockCounterClockwise,
  Coins,
  Gauge,
  Gear,
  House,
  Info,
  NotePencil,
  ShieldCheck,
  SignOut,
  Sparkle,
  Stack,
  Sun,
  Moon,
  Tray,
  Warning,
  XCircle,
  Briefcase,
} from "@phosphor-icons/react/ssr";
import type { Icon as PhosphorIcon, IconWeight } from "@phosphor-icons/react";

export type { PhosphorIcon, IconWeight };
export const ICON_SIZE = { sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof ICON_SIZE;

/** Decorative by default (aria-hidden); pass `label` when the icon alone carries meaning. */
export function AppIcon({ icon: Glyph, size = "sm", weight = "regular", label, className }: { icon: PhosphorIcon; size?: IconSize; weight?: IconWeight; label?: string; className?: string }) {
  return <Glyph size={ICON_SIZE[size]} weight={weight} className={clsx("shrink-0", className)} aria-label={label} aria-hidden={label ? undefined : true} role={label ? "img" : undefined} />;
}

/* ------------------------------------------------------------ categories */
export type Category = "stock" | "fund" | "bond" | "valuation" | "notes" | "metrics" | "event";
export const CATEGORY: Record<Category, { label: string; icon: PhosphorIcon; color: string }> = {
  stock: { label: "หุ้น", icon: ChartLineUp, color: "var(--cat-stock)" },
  fund: { label: "กองทุน", icon: Stack, color: "var(--cat-fund)" },
  bond: { label: "ตราสารหนี้", icon: Certificate, color: "var(--cat-bond)" },
  valuation: { label: "Valuation", icon: Calculator, color: "var(--cat-valuation)" },
  notes: { label: "Notes / Diary", icon: NotePencil, color: "var(--cat-notes)" },
  metrics: { label: "Metrics / Threshold", icon: Gauge, color: "var(--cat-metrics)" },
  event: { label: "Event / Catalyst", icon: CalendarStar, color: "var(--cat-event)" },
};

/** Asset class → category (หุ้น / กองทุน / ตราสารหนี้). Gold and cash have no category of their own. */
export const ASSET_CLASS_CATEGORY: Record<string, Category | undefined> = { thai_stock: "stock", us_stock: "stock", fund: "fund", bond: "bond" };

/** Tinted square-ish chip: category colour at ~12% behind a duotone icon of the same colour. 36 or 40px. */
export function IconChip({ category, icon, size = 36, label, className }: { category: Category; icon?: PhosphorIcon; size?: 36 | 40; label?: string; className?: string }) {
  const c = CATEGORY[category];
  return (
    <span
      className={clsx("inline-grid shrink-0 place-items-center rounded-full", className)}
      style={{ width: size, height: size, color: c.color, background: `color-mix(in srgb, ${c.color} 12%, transparent)` }}
      title={label}
    >
      <AppIcon icon={icon ?? c.icon} size="lg" weight="duotone" label={label} />
    </span>
  );
}

/* ---------------------------------------------------------------- status */
export type Status = "green" | "yellow" | "red" | "info";
export const STATUS_ICON: Record<Status, { icon: PhosphorIcon; cls: string; label: string }> = {
  green: { icon: CheckCircle, cls: "text-positive", label: "ปกติ" },
  yellow: { icon: Warning, cls: "text-warning", label: "เฝ้าระวัง" },
  red: { icon: XCircle, cls: "text-negative", label: "ผิดปกติ" },
  info: { icon: Info, cls: "text-primary", label: "ข้อมูล" },
};
/** Filled status icon; use together with a Badge / text (the Badge already does). */
export function StatusIcon({ status, size = "sm", className }: { status: Status; size?: IconSize; className?: string }) {
  const s = STATUS_ICON[status];
  return <AppIcon icon={s.icon} size={size} weight="fill" className={clsx(s.cls, className)} />;
}

/** Inline warning / info marks replacing emoji in messages. */
export function WarnMark({ className }: { className?: string }) {
  return <StatusIcon status="yellow" className={clsx("mr-1 inline align-text-bottom", className)} />;
}
export function InfoMark({ className }: { className?: string }) {
  return <StatusIcon status="info" className={clsx("mr-1 inline align-text-bottom", className)} />;
}

/* ------------------------------------------------------------ empty state */
/** 48–64px duotone illustration icon for empty states. */
export function EmptyIcon({ icon: Glyph = Tray, size = 56 }: { icon?: PhosphorIcon; size?: 48 | 56 | 64 }) {
  return <Glyph size={size} weight="duotone" aria-hidden className="text-text-muted" />;
}

/* ------------------------------------------------------------ navigation */
export const NAV_ICON = {
  home: House,
  journal: NotePencil,
  holdings: Briefcase,
  tx: ArrowsLeftRight,
  analytics: ChartBar,
  valuation: Calculator,
  bonds: Certificate,
  optimizer: ChartPieSlice,
  dividend: Coins,
  factors: ChartLineUp,
  backtest: ClockCounterClockwise,
  advisor: Sparkle,
  dq: ShieldCheck,
  settings: Gear,
  sun: Sun,
  moon: Moon,
  logout: SignOut,
} as const satisfies Record<string, PhosphorIcon>;
export type NavIconName = keyof typeof NAV_ICON;

/** Icon-only button: accessible name (aria-label) + native tooltip (title) are required. */
export function IconButton({ icon, label, onClick, size = "md", weight = "regular", className, type = "button" }: { icon: PhosphorIcon; label: string; onClick?: () => void; size?: IconSize; weight?: IconWeight; className?: string; type?: "button" | "submit" }) {
  return (
    <button type={type} onClick={onClick} aria-label={label} title={label} className={clsx("inline-grid size-9 place-items-center rounded-md text-text-muted hover:bg-panel-2 hover:text-text", className)}>
      <AppIcon icon={icon} size={size} weight={weight} />
    </button>
  );
}
