"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

const LINKS = [
  { href: "/", label: "ภาพรวม" },
  { href: "/journal", label: "บันทึก" },
  { href: "/holdings", label: "สินทรัพย์" },
  { href: "/transactions", label: "รายการ" },
  { href: "/analytics", label: "ผลการดำเนินงาน" },
  { href: "/valuation", label: "ประเมินมูลค่า" },
  { href: "/bonds", label: "พันธบัตร" },
  { href: "/optimizer", label: "จัดพอร์ต" },
  { href: "/advisor", label: "AI ที่ปรึกษา" },
  { href: "/settings", label: "ตั้งค่า" },
];

export function Nav({ logout }: { logout: () => Promise<void> }) {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-panel/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-2">
        <Link href="/" className="shrink-0 font-semibold text-accent">
          📒 Diary
        </Link>
        <nav className="flex flex-1 gap-1 overflow-x-auto text-sm">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={clsx("rounded-md px-2.5 py-1 whitespace-nowrap", active ? "bg-accent/10 font-medium text-accent" : "text-muted hover:text-text")}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <form action={logout}>
          <button className="text-xs text-muted hover:text-text">ออก</button>
        </form>
      </div>
    </header>
  );
}
