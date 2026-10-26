import { ValuationEditor } from "@/components/ValuationEditor";
import { SotpEditor } from "@/components/SotpEditor";
import { PageHeader } from "@/components/ui";
import { editorDefaults } from "@/server/services/valuation-defaults";
import { getStatementsWithMeta } from "@/server/services/statements";

const METHODS = ["dcf_fcff", "dcf_fcfe", "ddm", "residual_income", "multiples"] as const;

export default async function NewValuationPage({ searchParams }: { searchParams: Promise<{ symbol?: string; method?: string }> }) {
  const sp = await searchParams;
  const symbol = (sp.symbol ?? "").toUpperCase();
  if (sp.method === "sotp") {
    const { defaults, symbols } = await editorDefaults(symbol);
    return (
      <>
        <PageHeader title={`SOTP ${symbol}`} subtitle="Sum of the parts — แต่ละส่วนงานใช้โมเดลประเมินมูลค่าเดิม แล้วกระทบยอด EV → มูลค่าส่วนของผู้ถือหุ้น" />
        <SotpEditor symbol={symbol} symbols={symbols} defaults={defaults} />
      </>
    );
  }
  const method = (METHODS as readonly string[]).includes(sp.method ?? "") ? (sp.method as (typeof METHODS)[number]) : "dcf_fcff";
  const [{ defaults, symbols }, statements] = await Promise.all([editorDefaults(symbol), getStatementsWithMeta(symbol)]);
  return (
    <>
      <PageHeader title={`ประเมินมูลค่า ${symbol}`} subtitle="ตัวเลขคำนวณใหม่ทันทีเมื่อแก้สมมติฐาน" />
      <ValuationEditor symbol={symbol} symbols={symbols} method={method} defaults={defaults} statements={statements} />
    </>
  );
}
