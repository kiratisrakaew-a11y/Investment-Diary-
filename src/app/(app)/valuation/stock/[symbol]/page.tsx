import Link from "next/link";
import { notFound } from "next/navigation";
import { valuationsForSymbol } from "@/server/services/valuations";
import { getAssetBySymbol } from "@/server/services/assets";
import { priceHistoryFor } from "@/server/services/prices";
import { getStatements } from "@/server/services/statements";
import { SavedValuationList } from "@/components/SavedValuationList";
import { PageHeader, Section, Stat } from "@/components/ui";
import { METHOD_LABEL, fmtNum, fmtPct, signClass } from "@/lib/format";

const ALL_METHODS = ["dcf_fcff", "dcf_fcfe", "ddm", "residual_income", "multiples"];

export default async function StockValuationPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase();
  const [group, asset, statements] = await Promise.all([valuationsForSymbol(symbol), getAssetBySymbol(symbol), getStatements(symbol)]);
  if (!group && !asset) notFound();
  const hist = asset ? await priceHistoryFor(asset.id) : [];
  const price = hist[hist.length - 1]?.close ?? group?.latestByMethod[0]?.priceAtValuation ?? null;
  const avg = group?.average ?? null;
  const upside = avg && price ? avg / price - 1 : null;
  const unused = ALL_METHODS.filter((m) => !group?.methods.includes(m));
  const latestIds = new Set(group?.latestByMethod.map((r) => r.id));
  const max = Math.max(price ?? 0, ...(group?.latestByMethod.map((r) => r.intrinsicValue ?? 0) ?? [0])) * 1.1 || 1;

  return (
    <>
      <PageHeader
        title={`มูลค่าหุ้น ${symbol}`}
        subtitle={asset ? asset.name : undefined}
        action={
          <div className="flex flex-wrap gap-2">
            {unused.length > 0 && (
              <Link href={`/valuation/new?symbol=${symbol}&method=${unused[0]}`} className="btn">
                + ประเมินด้วย {METHOD_LABEL[unused[0]]}
              </Link>
            )}
            <Link href={`/valuation/new?symbol=${symbol}`} className="btn-ghost">+ valuation ใหม่</Link>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="ราคาล่าสุด" value={fmtNum(price)} sub={hist.length ? hist[hist.length - 1].date : undefined} />
        <Stat
          label="มูลค่าเฉลี่ย (ล่าสุดของแต่ละวิธี)"
          value={fmtNum(avg)}
          sub={group ? `มัธยฐาน ${fmtNum(group.median)} · ${group.methods.length} วิธี · ${group.count} ครั้ง` : "ยังไม่มี"}
        />
        <Stat label="ช่วงมูลค่า" value={group?.low != null ? `${fmtNum(group.low)} – ${fmtNum(group.high)}` : "–"} />
        <Stat
          label="Upside จากค่าเฉลี่ย"
          value={fmtPct(upside, 1)}
          tone={signClass(upside)}
          sub={upside != null && upside > 0 && avg ? `Margin of safety ${fmtPct(1 - (price ?? 0) / avg, 1)}` : undefined}
        />
      </div>

      {group && (
        <Section title="เทียบแต่ละวิธี (ฉบับล่าสุด)">
          <div className="space-y-2">
            {group.latestByMethod.map((r) => (
              <div key={r.id} className="text-xs">
                <div className="mb-0.5 flex justify-between">
                  <span>
                    {METHOD_LABEL[r.method]} <span className="text-muted">· {r.date}{r.title ? ` · ${r.title}` : ""}</span>
                  </span>
                  <span className="tabular-nums">{fmtNum(r.intrinsicValue)}</span>
                </div>
                <div className="relative h-2.5 rounded-full bg-border/50">
                  {r.intrinsicValue != null && r.intrinsicValue > 0 && (
                    <div className="h-2.5 rounded-full" style={{ width: `${Math.min(100, (r.intrinsicValue / max) * 100)}%`, background: "var(--series-1)" }} />
                  )}
                  {price != null && <div className="absolute -top-[3px] h-4 w-0.5 bg-text" style={{ left: `${(price / max) * 100}%` }} />}
                </div>
              </div>
            ))}
            <div className="text-right text-[11px] text-muted">เส้นตั้ง = ราคาล่าสุด {fmtNum(price)}</div>
          </div>
        </Section>
      )}

      <Section title={`Valuation ทั้งหมดของ ${symbol}`} action={<span className="text-xs text-muted">กดแต่ละรายการเพื่อดูสมมติฐานและวิธีคำนวณ</span>}>
        {group ? (
          <SavedValuationList
            currentPrice={price}
            rows={group.all.map((r) => ({
              id: r.id,
              date: r.date,
              method: r.method,
              title: r.title,
              note: r.note,
              source: r.source,
              intrinsicValue: r.intrinsicValue,
              priceAtValuation: r.priceAtValuation,
              assumptions: r.assumptions,
              isLatestForMethod: latestIds.has(r.id),
            }))}
          />
        ) : (
          <p className="text-sm text-muted">ยังไม่มี valuation ของหุ้นนี้</p>
        )}
      </Section>

      <Section title="งบการเงินย้อนหลัง">
        <p className="text-sm">
          {statements.length
            ? `มีข้อมูล ${statements.length} ปี (${statements[0].fiscalYear}–${statements[statements.length - 1].fiscalYear})`
            : "ยังไม่มีงบการเงิน"}{" "}
          · <Link href={`/valuation/new?symbol=${symbol}`} className="text-accent">อัปโหลด / แก้ไขงบในหน้าประเมินมูลค่า →</Link>
        </p>
      </Section>
    </>
  );
}
