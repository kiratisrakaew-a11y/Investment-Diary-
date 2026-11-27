import Link from "next/link";
import { getPortfolioSummary } from "@/server/services/portfolio";
import { listAssets } from "@/server/services/assets";
import { latestValuationBySymbol } from "@/server/services/valuations";
import { AddAssetForm, AddPriceForm } from "@/components/AssetForms";
import { ActionForm } from "@/components/ActionForm";
import { syncHistoryAction } from "../actions";
import { UpdatePricesButton } from "@/components/UpdatePricesButton";
import { PriceImport } from "@/components/PriceImport";
import { Card, EmptyState, KpiCard, PageHeader, Section } from "@/components/ui";
import { Tabs } from "@/components/ui-client";
import { HoldingsTable, type HoldingRow } from "@/components/HoldingsTable";
import { EmptyIcon, IconChip } from "@/components/icons";
import { Briefcase } from "@phosphor-icons/react/ssr";
import { DataQualityPanel } from "@/components/DataQuality";
import type { Position } from "@/lib/finance/portfolio";
import { fmtPct, fmtThb, signClass } from "@/lib/format";
import { compact } from "@/lib/explain-data";
import { AssetActionsMenu } from "@/components/AssetActionsMenu";
import { dependencyCounts } from "@/server/services/asset-lifecycle";

function priceBadges(p: Position): string[] {
  const badges: string[] = [];
  if (p.priceStatus === "stale") badges.push(`ราคาเก่า ${p.priceAgeDays} วัน`);
  if (p.priceStatus === "tx_price_fallback") badges.push("ใช้ราคาซื้อขาย");
  if (p.priceStatus === "missing") badges.push("ไม่มีราคา");
  if (p.fxStatus === "stale") badges.push("FX เก่า");
  if (p.fxStatus === "tx_fallback") badges.push("FX ณ วันซื้อขาย");
  return badges;
}

interface Chip {
  id: number;
  symbol: string;
  extra: string;
  hidden: boolean;
  archived: boolean;
  deps: number;
}

function ChipGroup({ title, items }: { title?: string; items: Chip[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      {title && <div className="mb-1 text-xs font-medium text-text-muted">{title}</div>}
      <ul className="flex flex-wrap gap-2">
        {items.map((a) => (
          <li key={a.id} className="relative flex items-center gap-1 rounded-lg border border-border bg-panel-2/60 py-1 pr-1 pl-2 text-xs">
            <Link href={`/holdings/${a.id}`} className="font-medium hover:text-primary">
              {a.symbol}
            </Link>
            {a.extra && <span className="text-xs text-text-muted">{a.extra}</span>}
            <AssetActionsMenu asset={{ id: a.id, symbol: a.symbol }} hidden={a.hidden} archived={a.archived} held={false} dependencyCount={a.deps} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function HoldingsPage() {
  const [summary, assets, vals] = await Promise.all([getPortfolioSummary(), listAssets(), latestValuationBySymbol()]);
  const open = summary.positions.filter((p) => p.quantity > 0);
  const closed = summary.positions.filter((p) => p.quantity === 0);
  const untouched = assets.filter((a) => !summary.positions.some((p) => p.assetId === a.id));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const depCounts = await dependencyCounts([...closed.map((p) => p.assetId), ...untouched.map((a) => a.id)]);
  const chip = (id: number, symbol: string, extra: string): Chip => ({
    id,
    symbol,
    extra,
    hidden: !!byId.get(id)?.hiddenInHoldingsAt,
    archived: !!byId.get(id)?.archivedAt,
    deps: depCounts.get(id) ?? 0,
  });
  const sold = closed.map((p) => chip(p.assetId, p.symbol, `รับรู้ ${fmtThb(p.realizedPnlThb + p.incomeThb)}`));
  const never = untouched.map((a) => chip(a.id, a.symbol, ""));
  const isVisible = (x: Chip) => !x.hidden && !x.archived;

  const rows: HoldingRow[] = open.map((p) => {
    const v = vals.get(p.symbol);
    return {
      assetId: p.assetId,
      symbol: p.symbol,
      name: p.name,
      assetClass: p.assetClass,
      quantity: p.quantity,
      avgCostThb: p.avgCostThb,
      lastPrice: p.lastPrice,
      currency: p.currency,
      lastPriceDate: p.lastPriceDate,
      badges: priceBadges(p),
      marketValueThb: p.marketValueThb,
      unrealizedPnlThb: p.unrealizedPnlThb,
      unrealizedPnlPct: p.unrealizedPnlPct,
      realizedIncomeThb: p.realizedPnlThb + p.incomeThb,
      weightPct: p.weightPct,
      valuation: v?.average != null ? { average: v.average, count: v.count } : null,
    };
  });
  const pnlPct = summary.netContributedThb > 0 ? summary.totalPnlThb / summary.netContributedThb : null;

  return (
    <div className="space-y-6">
      <PageHeader title="สินทรัพย์ที่ถือ" subtitle="ต้นทุนเฉลี่ย, มูลค่าตลาด และกำไร/ขาดทุน (บาท)" action={<UpdatePricesButton />} />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="มูลค่าพอร์ต" value={fmtThb(summary.totalValueThb)} note={`เงินสด ${fmtThb(summary.cashThb)}`} icon={<IconChip category="stock" icon={Briefcase} label="มูลค่าพอร์ต" />} />
        <KpiCard label="กำไร/ขาดทุนรวม" value={fmtThb(summary.totalPnlThb)} valueClassName={signClass(summary.totalPnlThb)} change={pnlPct} changeLabel="เทียบเงินลงทุน" />
        <KpiCard label="สินทรัพย์ที่ถืออยู่" value={String(open.length)} note={closed.length ? `ขายหมดแล้ว ${closed.length}` : undefined} />
        <KpiCard label="สัดส่วนที่ลงทุนอยู่" value={summary.totalValueThb > 0 ? fmtPct(1 - summary.cashThb / summary.totalValueThb, 0) : "—"} note="ส่วนที่เหลือเป็นเงินสด" />
      </div>

      <DataQualityPanel issues={summary.issues} reconciliation={summary.reconciliation} />

      <Section
        title="พอร์ตปัจจุบัน"
        explain={{
          data: compact(summary.positions.filter((p) => p.quantity > 0).map((p) => ({ สินทรัพย์: p.symbol, ประเภท: p.assetClass, จำนวน: p.quantity, ต้นทุนเฉลี่ยบาท: p.avgCostThb, ราคาล่าสุด: p.lastPrice, สกุล: p.currency, มูลค่าบาท: p.marketValueThb, กำไรยังไม่รับรู้บาท: p.unrealizedPnlThb, กำไรยังไม่รับรู้เปอร์เซ็นต์: p.unrealizedPnlPct, กำไรรับรู้แล้วบาท: p.realizedPnlThb, ปันผลดอกเบี้ยบาท: p.incomeThb, น้ำหนักเปอร์เซ็นต์: p.weightPct, สถานะราคา: p.priceStatus }))),
          hint: "กำไรยังไม่รับรู้ = มูลค่าตลาด − ต้นทุน (ยังไม่ได้ขาย); กำไรรับรู้แล้ว = จากที่ขายไปแล้ว",
        }}
      >
        {open.length === 0 ? (
          <EmptyState icon={<EmptyIcon icon={Briefcase} />} title="ยังไม่มีสินทรัพย์ในพอร์ต" description="เพิ่มสินทรัพย์ แล้วบันทึกการซื้อเพื่อเริ่มติดตามพอร์ต" action={<Link href="/transactions" className="btn">บันทึกการซื้อ</Link>} />
        ) : (
          <>
            <HoldingsTable rows={rows} />
            <p className="mt-3 text-xs text-text-muted">
              เงินสดในพอร์ต {fmtThb(summary.cashThb)} · รวมทั้งพอร์ต {fmtThb(summary.totalValueThb)} · P&amp;L รวม <span className={signClass(summary.totalPnlThb)}>{fmtThb(summary.totalPnlThb)}</span>
            </p>
          </>
        )}
      </Section>

      {(closed.length > 0 || untouched.length > 0) && (
        <Section title="สินทรัพย์อื่น ๆ (ไม่ได้ถืออยู่)">
          {/* Presentation only: hidden / archived chips never change accounting, prices or valuations. */}
          <ChipGroup title="ขายหมดแล้ว" items={sold.filter(isVisible)} />
          <ChipGroup title="ยังไม่ได้ซื้อ / ติดตาม" items={never.filter(isVisible)} />
          {[...sold, ...never].some((x) => x.hidden && !x.archived) && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-text-muted">ซ่อนไว้ ({[...sold, ...never].filter((x) => x.hidden && !x.archived).length})</summary>
              <ChipGroup items={[...sold, ...never].filter((x) => x.hidden && !x.archived)} />
            </details>
          )}
          {[...sold, ...never].some((x) => x.archived) && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-text-muted">เก็บถาวร ({[...sold, ...never].filter((x) => x.archived).length}) — ไม่ถูกเลือกในการจัดพอร์ตโดยค่าเริ่มต้น</summary>
              <ChipGroup items={[...sold, ...never].filter((x) => x.archived)} />
            </details>
          )}
          <p className="mt-3 text-xs text-text-muted">⋯ = ซ่อน / เก็บถาวร / ลบถาวร · การซ่อนมีผลแค่หน้านี้ ไม่กระทบผลตอบแทน ประวัติ valuation หรือการจัดพอร์ต · ลบถาวรได้เฉพาะสินทรัพย์ที่ไม่มีข้อมูลอ้างถึง</p>
        </Section>
      )}

      <Card>
        <Tabs
          ariaLabel="เพิ่มและนำเข้าข้อมูล"
          tabs={[
            { id: "add", label: "เพิ่มสินทรัพย์", content: <AddAssetForm /> },
            { id: "price", label: "บันทึกราคาเอง", content: (<div className="space-y-3"><p className="text-xs text-text-muted">พันธบัตร / กองทุน / ราคาที่ดึงไม่ได้</p>{assets.length ? <AddPriceForm assets={assets.filter((a) => !a.archivedAt)} /> : <EmptyState title="เพิ่มสินทรัพย์ก่อน" description="ต้องมีสินทรัพย์อย่างน้อยหนึ่งตัวจึงจะบันทึกราคาเองได้" />}</div>) },
            { id: "import", label: "นำเข้าจากไฟล์", content: (<div><PriceImport />
        <p className="mt-2 text-xs text-text-muted">
          รองรับ 3 แบบ: (1) symbol, date, close[, adj close] (2) date แล้วคอลัมน์ละหุ้น เช่น date, PTT, BBL (3) ไฟล์ราคาหุ้นตัวเดียวจาก Yahoo / Investing / SETSMART (ใส่สัญลักษณ์) ·
          วันที่แบบ 2026-01-05, 05/01/2026 (วัน/เดือน), ปี พ.ศ. หรือวันที่ของ Excel · สูงสุด 50,000 แถว · ไม่เขียนทับราคาเดิมถ้าไม่เลือก · สัญลักษณ์ที่ยังไม่มีจะถูกรายงาน ไม่สร้างให้ · Claude/ChatGPT ใช้เครื่องมือ import_prices ได้
        </p>
      </div>) },
            { id: "sync", label: "ดึงราคาย้อนหลัง", content: (<div><ActionForm action={syncHistoryAction} className="grid gap-3 sm:grid-cols-6" resetOnSuccess={false} submitLabel="ดึงราคา">
          <div className="sm:col-span-3">
            <label className="label">สัญลักษณ์ (คั่นด้วยจุลภาค) — ต้องเพิ่มเป็นสินทรัพย์แล้ว</label>
            <input name="symbols" className="input" placeholder="BBL, AP" defaultValue={assets.filter((a) => a.priceSource !== "manual").map((a) => a.symbol).join(", ")} />
          </div>
          <div>
            <label className="label">ย้อนหลัง (วัน)</label>
            <input name="lookbackDays" type="number" min={1} max={3660} className="input" defaultValue={365} />
          </div>
          <div>
            <label className="label">หรือ ตั้งแต่</label>
            <input name="startDate" type="date" className="input" />
          </div>
          <div>
            <label className="label">ถึง</label>
            <input name="endDate" type="date" className="input" />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm sm:col-span-6">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="dryRun" defaultChecked className="accent-[var(--primary)]" /> ทดลองก่อน (ไม่บันทึก)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="overwrite" className="accent-[var(--primary)]" /> เขียนทับราคาที่มีอยู่
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="adjusted" className="accent-[var(--primary)]" /> เก็บราคาปรับปันผล (adjusted) แยกด้วย
            </label>
          </div>
        </ActionForm>
        <p className="mt-2 text-xs text-text-muted">
          ดึงจาก Yahoo (หุ้น/ทอง/ดัชนี/USDTHB) และ ก.ล.ต. (NAV กองทุน ≤ {400} วัน) · ไม่เขียนทับราคาเดิมถ้าไม่เลือก · สัญลักษณ์ที่ยังไม่มีในรายการจะถูกรายงาน ไม่สร้างให้ · Claude/ChatGPT ใช้เครื่องมือ sync_historical_prices ได้เหมือนกัน
        </p>
      </div>) },
          ]}
        />
      </Card>
    </div>
  );
}
