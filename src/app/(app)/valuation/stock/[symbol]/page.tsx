import Link from "next/link";
import { notFound } from "next/navigation";
import { valuationsForSymbol } from "@/server/services/valuations";
import { getAssetBySymbol } from "@/server/services/assets";
import { priceHistoryFor } from "@/server/services/prices";
import { getStatements } from "@/server/services/statements";
import { getTimestampPolicy } from "@/server/services/settings";
import { priceDateAt, statementsAsOfAt, timestampFlags } from "@/lib/governance";
import { SavedValuationList } from "@/components/SavedValuationList";
import { PageHeader, Section } from "@/components/ui";
import { METHOD_LABEL, fmtNum, fmtPct, signClass } from "@/lib/format";
import { compact } from "@/lib/explain-data";

const ALL_METHODS = ["dcf_fcff", "dcf_fcfe", "ddm", "residual_income", "multiples", "sotp"];

export default async function StockValuationPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase();
  const [group, asset, statements, tsPolicy] = await Promise.all([valuationsForSymbol(symbol), getAssetBySymbol(symbol), getStatements(symbol), getTimestampPolicy()]);
  if (!group && !asset) notFound();
  const hist = asset ? await priceHistoryFor(asset.id) : [];
  const price = hist[hist.length - 1]?.close ?? group?.latestByMethod[0]?.priceAtValuation ?? null;
  const avg = group?.average ?? null;
  const upside = avg && price ? avg / price - 1 : null;
  const unused = ALL_METHODS.filter((m) => !group?.methods.includes(m));
  const latestIds = new Set(group?.latestByMethod.map((r) => r.id));
  const priceDates = hist.map((h) => h.date);
  const fiscalYears = statements.map((y) => y.fiscalYear);
  // Inputs, last stored price and latest fiscal year, each as of the valuation date (never after it).
  const flagsFor = (r: { date: string; assumptions: unknown }) => {
    const st = statementsAsOfAt(fiscalYears, r.date);
    return timestampFlags(
      {
        valuationDate: r.date,
        inputsAsOf: (r.assumptions as { inputMeta?: { asOf?: string } } | null)?.inputMeta?.asOf,
        priceDate: priceDates.length ? priceDateAt(priceDates, r.date) : null,
        statementsAsOf: st?.asOf,
        statementsLabel: st?.label,
      },
      tsPolicy,
    );
  };
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
            <Link href={`/valuation/new?symbol=${symbol}&method=sotp`} className="btn-ghost">+ SOTP</Link>
          </div>
        }
      />

      <section className="card">
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          <Metric k="ราคาปิดล่าสุดในระบบ" v={fmtNum(price)} sub={hist.length ? `ณ ${hist[hist.length - 1].date} · ไม่ใช่ราคาเรียลไทม์` : "ไม่มีราคาในระบบ — ใช้ราคาวันประเมิน"} />
          <Metric
            k="มูลค่าเฉลี่ย (ล่าสุดของแต่ละวิธี)"
            v={fmtNum(avg)}
            sub={group ? `มัธยฐาน ${fmtNum(group.median)} · ${group.methods.length} วิธี · ${group.count} ครั้ง` : "ยังไม่มี"}
          />
          <Metric k="ช่วงมูลค่า" v={group?.low != null ? `${fmtNum(group.low)} – ${fmtNum(group.high)}` : "–"} />
          <Metric
            k="Upside จากค่าเฉลี่ย"
            v={fmtPct(upside, 1)}
            tone={signClass(upside)}
            sub={upside != null && upside > 0 && avg ? `Margin of safety ${fmtPct(1 - (price ?? 0) / avg, 1)}` : undefined}
          />
        </dl>
      </section>

      {group && (
        <Section title="เทียบแต่ละวิธี (ฉบับล่าสุด)" explain={{ data: compact({ symbol, ราคาล่าสุด: hist.at(-1) ?? null, ต่ำสุด: group.low, สูงสุด: group.high, เฉลี่ย: group.average, มัธยฐาน: group.median, รายวิธี: group.latestByMethod.map((v) => ({ วิธี: v.method, วันที่: v.date, มูลค่าต่อหุ้น: v.intrinsicValue })) }), hint: "แต่ละวิธีใช้สมมติฐานต่างกัน ช่วงมูลค่าที่กว้างแปลว่าความไม่แน่นอนสูง" }}>
          <div className="glass-inset space-y-3 rounded-xl p-3" role="group" aria-label="football field: มูลค่าล่าสุดของแต่ละวิธีเทียบราคา">
            {group.latestByMethod.map((r) => (
              <div key={r.id} className="text-xs">
                <div className="mb-0.5 flex justify-between">
                  <span>
                    {METHOD_LABEL[r.method]} <span className="text-muted">· {r.date}{r.title ? ` · ${r.title}` : ""}</span>
                  </span>
                  <span className="tabular-nums">{fmtNum(r.intrinsicValue)}</span>
                </div>
                <div
                  className="relative h-2.5 rounded-full bg-panel-2"
                  role="img"
                  aria-label={`${METHOD_LABEL[r.method]} ${fmtNum(r.intrinsicValue)}${price != null ? ` เทียบราคา ${fmtNum(price)}` : ""}`}
                >
                  {r.intrinsicValue != null && r.intrinsicValue > 0 && (
                    <div className="h-2.5 rounded-full bg-linear-to-r from-accent-2 to-accent" style={{ width: `${Math.min(100, (r.intrinsicValue / max) * 100)}%` }} />
                  )}
                  {price != null && <div className="absolute -top-[3px] h-4 w-0.5 rounded bg-text" style={{ left: `${(price / max) * 100}%` }} />}
                </div>
              </div>
            ))}
            <div className="text-right text-[11px] text-muted">
              เส้นตั้ง = ราคาปิดล่าสุด {fmtNum(price)}
              {hist.length ? ` ณ ${hist[hist.length - 1].date}` : ""}
            </div>
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
              modelVersion: (r.result as { modelVersion?: string } | null)?.modelVersion,
              isLatestForMethod: latestIds.has(r.id),
              timestampFlags: flagsFor(r),
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

function Metric({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{k}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${tone ?? ""}`}>{v}</dd>
      {sub && <dd className="text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}
