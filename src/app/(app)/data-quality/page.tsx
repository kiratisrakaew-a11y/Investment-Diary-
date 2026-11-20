import Link from "next/link";
import { dataQualityReport } from "@/server/services/data-quality";
import { PageHeader, Section } from "@/components/ui";
import { compact } from "@/lib/explain-data";
import { BENCHMARK_KIND_LABEL, RETURN_BASIS_SHORT } from "@/lib/finance/price-basis";

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

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="ดัชนีอ้างอิงในระบบ" subtitle="ชนิดของดัชนีใช้จับคู่กับชนิดราคา — แก้ชนิดได้ที่หน้าตั้งค่า">
          <table className="w-full text-xs" data-testid="dq-benchmarks">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1">ดัชนี</th>
                <th>ชนิด</th>
                <th>ช่วงข้อมูล</th>
                <th className="text-right">วัน</th>
              </tr>
            </thead>
            <tbody>
              {r.benchmarks.map((b) => (
                <tr key={b.symbol} className="border-t border-border">
                  <td className="py-1 font-medium">{b.symbol}</td>
                  <td>{BENCHMARK_KIND_LABEL[b.kind]}</td>
                  <td>{b.from ? `${b.from} → ${b.to}` : "ยังไม่มีข้อมูล"}</td>
                  <td className="text-right tabular-nums">{b.days}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            ค่าเริ่มต้น: ราคา {RETURN_BASIS_SHORT[r.priceBasisDefaults.defaultReturnBasis]} · ดัชนี {r.priceBasisDefaults.defaultBenchmark === "default" ? "ตามค่าเดิมของแต่ละหน้า" : r.priceBasisDefaults.defaultBenchmark === "auto" ? "อัตโนมัติ (ชนิดตรงกับราคา)" : r.priceBasisDefaults.defaultBenchmark}
          </p>
        </Section>
        <Section title="ราคาปรับปันผล (adj_close) รายสินทรัพย์" subtitle="3 ปีล่าสุด · สินทรัพย์ที่ยังไม่ archive">
          <table className="w-full text-xs" data-testid="dq-adj">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1">สินทรัพย์</th>
                <th className="text-right">มี adj / ราคาทั้งหมด</th>
                <th className="text-right">ครอบคลุม</th>
              </tr>
            </thead>
            <tbody>
              {r.adjCoverage.map((a) => (
                <tr key={a.symbol} className="border-t border-border">
                  <td className="py-1">
                    {a.symbol}
                    {a.held && <span className="ml-1 text-muted">(ถืออยู่)</span>}
                  </td>
                  <td className="text-right tabular-nums">
                    {a.withAdjClose} / {a.days}
                  </td>
                  <td className={`text-right tabular-nums ${a.ratio < 1 ? "text-warn" : ""}`}>{(a.ratio * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            ทอง กองทุนสะสมมูลค่า และหุ้นที่ไม่มีปันผล/แตกพาร์ในช่วงนั้นไม่ต้องมี adj_close (ราคาปิดคือผลตอบแทนรวม)
          </p>
        </Section>
      </div>
    </>
  );
}
