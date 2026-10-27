import Link from "next/link";
import { dataQualityReport } from "@/server/services/data-quality";
import { PageHeader, Section } from "@/components/ui";
import { compact } from "@/lib/explain-data";

const ICON = { ok: "✅", warn: "⚠️", error: "❌" } as const;

export default async function DataQualityPage() {
  const r = await dataQualityReport();
  return (
    <>
      <PageHeader
        title="คุณภาพข้อมูลและสมมติฐาน"
        subtitle={`สถานะรวม: ${r.status === "ok" ? "ครบถ้วน" : r.status === "warnings" ? "มีคำเตือน" : "มีข้อผิดพลาด"} · สูตรเวอร์ชัน ${r.modelVersion}`}
      />
      <Section title="รายการตรวจสอบ" explain={{ data: compact(r), hint: "อธิบายว่าแต่ละรายการตรวจสอบหมายถึงอะไร กระทบตัวเลขไหน และควรแก้อย่างไร" }}>
        <ul className="divide-y divide-border">
          {r.checks.map((c) => (
            <li key={c.area} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
              <span className="w-32 shrink-0 font-medium">
                {ICON[c.status]} {c.area}
              </span>
              <span className={`min-w-0 flex-1 ${c.status === "ok" ? "text-muted" : ""}`}>{c.message}</span>
              {c.href && c.status !== "ok" && (
                <Link href={c.href} className="text-xs text-accent">
                  แก้ไข →
                </Link>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          ตัวเลขที่มีคำเตือนยังคำนวณและแสดงได้ แต่ควรอ่านพร้อมเงื่อนไขนี้ · ระบบไม่แก้ข้อมูลเดิมให้เอง · รายละเอียดสูตรดู docs/MODEL_DOCUMENTATION.md ใน repository
        </p>
      </Section>
    </>
  );
}
