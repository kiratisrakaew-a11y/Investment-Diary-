import Link from "next/link";
import { notFound } from "next/navigation";
import { valuationsForSymbol } from "@/server/services/valuations";
import { getAssetBySymbol } from "@/server/services/assets";
import { priceHistoryFor } from "@/server/services/prices";
import { getStatements } from "@/server/services/statements";
import { getTimestampPolicy } from "@/server/services/settings";
import { priceDateAt, statementsAsOfAt, timestampFlags } from "@/lib/governance";
import { SavedValuationList, type SavedValuationRow } from "@/components/SavedValuationList";
import { Card, KpiCard, PageHeader, Section } from "@/components/ui";
import { Tabs } from "@/components/ui-client";
import { IconChip } from "@/components/icons";
import { METHOD_LABEL, fmtNum, fmtPct, formatChange } from "@/lib/format";
import { compact } from "@/lib/explain-data";
import { consensusSummary } from "@/server/services/consensus";
import { ConsensusCard } from "@/components/ConsensusCard";
import { today } from "@/lib/validation";

const ALL_METHODS = ["dcf_fcff", "dcf_fcfe", "ddm", "residual_income", "multiples", "sotp"];

export default async function StockValuationPage({ params }: { params: Promise<{ symbol: string }> }) {
  const symbol = decodeURIComponent((await params).symbol).toUpperCase();
  const [group, asset, statements, tsPolicy, consensus] = await Promise.all([valuationsForSymbol(symbol), getAssetBySymbol(symbol), getStatements(symbol), getTimestampPolicy(), consensusSummary(symbol, { history: true })]);
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
  const cons = consensus.latest;
  const consTarget = consensus.view?.target ?? null;
  const max = Math.max(price ?? 0, cons?.targetHigh ?? 0, consTarget ?? 0, ...(group?.latestByMethod.map((r) => r.intrinsicValue ?? 0) ?? [0])) * 1.1 || 1;

  return (
    <div className="space-y-6">
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
            <Link href={`/valuation/new?symbol=${symbol}`} className={unused.length > 0 ? "btn-ghost" : "btn"}>+ valuation ใหม่</Link>
            <Link href={`/valuation/new?symbol=${symbol}&method=sotp`} className="btn-ghost">+ SOTP</Link>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="ราคาปิดล่าสุดในระบบ" value={fmtNum(price)} note={hist.length ? `ณ ${hist[hist.length - 1].date} · ไม่ใช่ราคาเรียลไทม์` : "ไม่มีราคาในระบบ — ใช้ราคาวันประเมิน"} icon={<IconChip category="stock" label="ราคา" />} />
        <KpiCard label="มูลค่าเฉลี่ย (FV)" value={fmtNum(avg)} note={group ? `มัธยฐาน ${fmtNum(group.median)} · ${group.methods.length} วิธี · ${group.count} ครั้ง` : "ยังไม่มี"} icon={<IconChip category="valuation" label="มูลค่าเฉลี่ย" />} />
        <KpiCard
          label="Upside จากค่าเฉลี่ย"
          value={upside == null ? "—" : formatChange(upside).text}
          valueClassName={formatChange(upside).className}
          note={upside != null && upside > 0 && avg ? `Margin of safety ${fmtPct(1 - (price ?? 0) / avg, 1)}` : undefined}
        />
        <KpiCard label="ช่วงมูลค่า" value={group?.low != null ? `${fmtNum(group.low)} – ${fmtNum(group.high)}` : "—"} note="ต่ำสุด – สูงสุดของแต่ละวิธี" />
      </div>

      {group && (
        <Section title="เทียบแต่ละวิธี (ฉบับล่าสุด)" explain={{ data: compact({ symbol, ราคาล่าสุด: hist.at(-1) ?? null, ต่ำสุด: group.low, สูงสุด: group.high, เฉลี่ย: group.average, มัธยฐาน: group.median, รายวิธี: group.latestByMethod.map((v) => ({ วิธี: v.method, วันที่: v.date, มูลค่าต่อหุ้น: v.intrinsicValue })) }), hint: "แต่ละวิธีใช้สมมติฐานต่างกัน ช่วงมูลค่าที่กว้างแปลว่าความไม่แน่นอนสูง" }}>
          <div className="glass-inset space-y-3 rounded-xl p-3" role="group" aria-label="football field: มูลค่าล่าสุดของแต่ละวิธีเทียบราคา">
            {group.latestByMethod.map((r) => (
              <div key={r.id} className="text-xs">
                <div className="mb-1 flex justify-between">
                  <span>
                    {METHOD_LABEL[r.method]} <span className="text-text-muted">· {r.date}{r.title ? ` · ${r.title}` : ""}</span>
                  </span>
                  <span className="tabular-nums">{fmtNum(r.intrinsicValue)}</span>
                </div>
                <div
                  className="relative h-2.5 rounded-full bg-panel-2"
                  role="img"
                  aria-label={`${METHOD_LABEL[r.method]} ${fmtNum(r.intrinsicValue)}${price != null ? ` เทียบราคา ${fmtNum(price)}` : ""}`}
                >
                  {r.intrinsicValue != null && r.intrinsicValue > 0 && (
                    <div className="h-2.5 rounded-full bg-primary" style={{ width: `${Math.min(100, (r.intrinsicValue / max) * 100)}%` }} />
                  )}
                  {price != null && <div className="absolute -top-[3px] h-4 w-0.5 rounded-md bg-text" style={{ left: `${(price / max) * 100}%` }} />}
                </div>
              </div>
            ))}
            {cons && consTarget != null && (
              <div className="border-t border-dashed border-border pt-2 text-xs">
                <div className="mb-1 flex justify-between">
                  <span>
                    Consensus นักวิเคราะห์ <span className="text-text-muted">· {cons.asOf} · ไม่นับรวมในค่าเฉลี่ย</span>
                  </span>
                  <span className="tabular-nums">
                    {fmtNum(consTarget)}
                    {cons.targetLow != null && cons.targetHigh != null && <span className="text-text-muted"> ({fmtNum(cons.targetLow)} – {fmtNum(cons.targetHigh)})</span>}
                  </span>
                </div>
                <div className="relative h-2.5 rounded-full bg-panel-2" role="img" aria-label={`Consensus นักวิเคราะห์ ${fmtNum(consTarget)}${cons.targetLow != null && cons.targetHigh != null ? ` ช่วง ${fmtNum(cons.targetLow)}–${fmtNum(cons.targetHigh)}` : ""}`}>
                  {cons.targetLow != null && cons.targetHigh != null && (
                    <div
                      className="absolute h-2.5 rounded-full border border-dashed border-text-muted/70 bg-text-muted/20"
                      style={{ left: `${(cons.targetLow / max) * 100}%`, width: `${Math.max(0.5, ((cons.targetHigh - cons.targetLow) / max) * 100)}%` }}
                    />
                  )}
                  <div className="absolute -top-[2px] h-3.5 w-3.5 -translate-x-1/2 rotate-45 rounded-[2px] border-2 border-panel-solid bg-text-muted" style={{ left: `${(consTarget / max) * 100}%` }} />
                  {price != null && <div className="absolute -top-[3px] h-4 w-0.5 rounded-md bg-text" style={{ left: `${(price / max) * 100}%` }} />}
                </div>
              </div>
            )}
            <div className="text-right text-xs text-text-muted">
              เส้นตั้ง = ราคาปิดล่าสุด {fmtNum(price)}
              {hist.length ? ` ณ ${hist[hist.length - 1].date}` : ""}
            </div>
          </div>
        </Section>
      )}

      <Section title={`Valuation ทั้งหมดของ ${symbol}`} action={<span className="text-xs text-text-muted">กดแต่ละรายการเพื่อดูสมมติฐานและวิธีคำนวณ</span>}>
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
              scenario: (r.result as { scenarioAnalysis?: SavedValuationRow["scenario"] } | null)?.scenarioAnalysis ?? null,
              isLatestForMethod: latestIds.has(r.id),
              timestampFlags: flagsFor(r),
            }))}
          />
        ) : (
          <p className="text-sm text-text-muted">ยังไม่มี valuation ของหุ้นนี้</p>
        )}
      </Section>

      <Card>
        <Tabs
          ariaLabel="รายละเอียดเพิ่มเติมของหุ้น"
          tabs={[
            {
              id: "consensus",
              label: "Consensus นักวิเคราะห์",
              content: (
      <ConsensusCard symbol={symbol} latest={cons} view={consensus.view} history={consensus.history ?? []} price={consensus.price} priceDate={consensus.priceDate} today={today()} />
              ),
            },
            {
              id: "statements",
              label: "งบการเงินย้อนหลัง",
              content: (
                <p className="text-sm">
                  {statements.length ? `มีข้อมูล ${statements.length} ปี (${statements[0].fiscalYear}–${statements[statements.length - 1].fiscalYear})` : "ยังไม่มีงบการเงิน"} ·{" "}
                  <Link href={`/valuation/new?symbol=${symbol}`} className="text-primary">
                    อัปโหลด / แก้ไขงบในหน้าประเมินมูลค่า →
                  </Link>
                </p>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
