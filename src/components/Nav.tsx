"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

import { AppIcon, NAV_ICON, type IconSize, type NavIconName } from "./icons";

/** Sidebar / header icon: regular when idle, duotone when active (Phosphor, see icons.tsx). */
export function Icon({ name, className, active, size = "sm" }: { name: NavIconName | string; className?: string; active?: boolean; size?: IconSize }) {
  return <AppIcon icon={NAV_ICON[name as NavIconName] ?? NAV_ICON.home} size={size} weight={active ? "duotone" : "regular"} className={className} />;
}

const LINKS = [
  { href: "/", label: "ภาพรวม", icon: "home" },
  { href: "/journal", label: "บันทึก", icon: "journal" },
  { href: "/holdings", label: "สินทรัพย์", icon: "holdings" },
  { href: "/transactions", label: "รายการ", icon: "tx" },
  { href: "/analytics", label: "ผลการดำเนินงาน", icon: "analytics" },
  { href: "/valuation", label: "ประเมินมูลค่า", icon: "valuation" },
  { href: "/bonds", label: "พันธบัตร", icon: "bonds" },
  { href: "/optimizer", label: "จัดพอร์ต", icon: "optimizer" },
  { href: "/dividends", label: "ปันผล", icon: "dividend" },
  { href: "/factors", label: "กลยุทธ์ปัจจัย", icon: "factors" },
  { href: "/backtest", label: "Backtest", icon: "backtest" },
  { href: "/advisor", label: "AI ที่ปรึกษา", icon: "advisor" },
  { href: "/data-quality", label: "คุณภาพข้อมูล", icon: "dq" },
  { href: "/settings", label: "ตั้งค่า", icon: "settings" },
];

function ThemeToggle({ compact }: { compact?: boolean }) {
  const [theme, setTheme] = useState<"dim" | "light">("dim");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dim");
  }, []);
  const toggle = () => {
    const next = theme === "dim" ? "light" : "dim";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setTheme(next);
  };
  return (
    <button type="button" onClick={toggle} className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-text-muted hover:text-text" title="สลับธีมสว่าง / มืดนุ่ม" aria-label="สลับธีมสว่าง / มืดนุ่ม">
      <Icon name={theme === "dim" ? "sun" : "moon"} size="md" />
      {!compact && (theme === "dim" ? "ธีมสว่าง" : "ธีมมืดนุ่ม")}
    </button>
  );
}

export function Nav({ logout }: { logout: () => Promise<void> }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-border glass lg:flex">
        <Link href="/" className="flex items-center gap-3 border-b border-border px-5 py-5">
          <span className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary">
            <Icon name="journal" size="lg" active />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-wide">INVESTMENT DIARY</span>
            <span className="block text-xs text-muted">Portfolio analytics · THB</span>
          </span>
        </Link>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3 text-sm">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 transition-colors",
                isActive(l.href) ? "bg-primary font-medium text-primary-ink" : "text-text-muted hover:bg-panel-2 hover:text-text",
              )}
            >
              <Icon name={l.icon} size="md" active={isActive(l.href)} />
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center justify-between border-t border-border p-2">
          <ThemeToggle />
          <form action={logout}>
            <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted hover:text-text">
              <Icon name="logout" size="md" /> ออก
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile / tablet top bar */}
      <header className="sticky top-0 z-20 border-b border-border glass lg:hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold text-primary">
            <Icon name="journal" size="lg" active /> Diary
          </Link>
          <nav className="flex flex-1 gap-1 overflow-x-auto text-sm">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1 whitespace-nowrap", isActive(l.href) ? "bg-primary font-medium text-primary-ink" : "text-text-muted hover:text-text")}
              >
                <Icon name={l.icon} active={isActive(l.href)} />
                {l.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle compact />
        </div>
      </header>
    </>
  );
}
