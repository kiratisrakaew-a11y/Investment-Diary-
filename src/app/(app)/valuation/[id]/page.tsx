import { notFound } from "next/navigation";
import { ValuationEditor } from "@/components/ValuationEditor";
import { PageHeader } from "@/components/ui";
import { getValuation } from "@/server/services/valuations";
import { editorDefaults } from "@/server/services/valuation-defaults";

export default async function EditValuationPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await getValuation(Number((await params).id));
  if (!v || v.method === "bond") notFound();
  const { defaults, symbols } = await editorDefaults(v.symbol);
  return (
    <>
      <PageHeader title={`ประเมินมูลค่า ${v.symbol}`} subtitle={`บันทึกเมื่อ ${v.date}${v.title ? ` · ${v.title}` : ""}`} />
      <ValuationEditor
        id={v.id}
        symbol={v.symbol}
        symbols={symbols}
        method={v.method}
        assumptions={v.assumptions}
        title={v.title}
        note={v.note}
        defaults={defaults}
      />
    </>
  );
}
