"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

// 24×24 stroke icons (lucide-style paths, drawn inline to avoid a dependency).
const I: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  journal: "M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4",
  holdings: "M4 7h16v13H4zM8 7V4h8v3",
  tx: "M7 7h13l-3-3M17 17H4l3 3",
  analytics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  valuation: "M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6",
  bonds: "M4 6h16v12H4zM4 10h16M8 15h3",
  optimizer: "M12 3a9 9 0 1 0 9 9h-9z M14 3.3A9 9 0 0 1 20.7 10H14z",
  backtest: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  advisor: "M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z",
  dividend: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6M19 19l2 2M21 15v6h-6",
  dq: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM9 12l2 2 4-4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
};

export function Icon({ name, className }: { name: keyof typeof I | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={clsx("size-4 shrink-0", className)} aria-hidden>
      <path d={I[name] ?? I.home} />
    </svg>
  );
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
    <button type="button" onClick={toggle} className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted hover:text-text" title="สลับธีมสว่าง / มืดนุ่ม">
      <Icon name={theme === "dim" ? "sun" : "moon"} />
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
          <span className="grid size-9 place-items-center rounded-xl bg-accent/15 text-accent">
            <Icon name="journal" className="size-5" />
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-wide">INVESTMENT DIARY</span>
            <span className="block text-[11px] text-muted">Portfolio analytics · THB</span>
          </span>
        </Link>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3 text-sm">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 transition-colors",
                isActive(l.href) ? "bg-linear-to-r from-accent to-accent-2 font-medium text-accent-ink shadow-[0_4px_14px_rgb(255_120_60/0.35)]" : "text-muted hover:bg-panel-2 hover:text-text",
              )}
            >
              <Icon name={l.icon} />
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center justify-between border-t border-border p-2">
          <ThemeToggle />
          <form action={logout}>
            <button className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted hover:text-text">
              <Icon name="logout" /> ออก
            </button>
          </form>
        </div>
      </aside>

      {/* Mobile / tablet top bar */}
      <header className="sticky top-0 z-20 border-b border-border glass lg:hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold text-accent">
            <Icon name="journal" className="size-5" /> Diary
          </Link>
          <nav className="flex flex-1 gap-1 overflow-x-auto text-sm">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1 whitespace-nowrap", isActive(l.href) ? "bg-linear-to-r from-accent to-accent-2 font-medium text-accent-ink" : "text-muted hover:text-text")}
              >
                <Icon name={l.icon} className="size-3.5" />
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
