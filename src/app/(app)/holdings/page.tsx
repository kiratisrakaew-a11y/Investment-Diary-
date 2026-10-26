import Link from "next/link";
import { getPortfolioSummary } from "@/server/services/portfolio";
import { listAssets } from "@/server/services/assets";
import { latestValuationBySymbol } from "@/server/services/valuations";
import { AddAssetForm, AddPriceForm } from "@/components/AssetForms";
import { ActionForm } from "@/components/ActionForm";
import { syncHistoryAction } from "../actions";
import { UpdatePricesButton } from "@/components/UpdatePricesButton";
import { Empty, PageHeader, Section } from "@/components/ui";
import { DataQualityPanel } from "@/components/DataQuality";
import type { Position } from "@/lib/finance/portfolio";
import { ASSET_CLASS_COLOR, ASSET_CLASS_LABEL, fmtNum, fmtPctRaw, fmtQty, fmtThb, signClass } from "@/lib/format";

function PriceBadges({ p }: { p: Position }) {
  const badges: string[] = [];
  if (p.priceStatus === "stale") badges.push(`ราคาเก่า ${p.priceAgeDays} วัน`);
  if (p.priceStatus === "tx_price_fallback") badges.push("ใช้ราคาซื้อขาย");
  if (p.priceStatus === "missing") badges.push("ไม่มีราคา");
  if (p.fxStatus === "stale") badges.push("FX เก่า");
  if (p.fxStatus === "tx_fallback") badges.push("FX ณ วันซื้อขาย");
  if (!badges.length) return null;
  return (
    <div className="mt-0.5 flex flex-wrap justify-end gap-1">
      {badges.map((b) => (
        <span key={b} className="rounded bg-neg/10 px-1 text-[11px] text-neg">
          {b}
        </span>
      ))}
    </div>
  );
}

export default async function HoldingsPage() {
  const [summary, assets, vals] = await Promise.all([getPortfolioSummary(), listAssets(), latestValuationBySymbol()]);
  const open = summary.positions.filter((p) => p.quantity > 0);
  const closed = summary.positions.filter((p) => p.quantity === 0);
  const untouched = assets.filter((a) => !summary.positions.some((p) => p.assetId === a.id));

  return (
    <>
      <PageHeader title="สินทรัพย์ที่ถือ" subtitle="ต้นทุนเฉลี่ย, มูลค่าตลาด และกำไร/ขาดทุน (บาท)" action={<UpdatePricesButton />} />

      <DataQualityPanel issues={summary.issues} reconciliation={summary.reconciliation} />

      <Section title="พอร์ตปัจจุบัน">
        {open.length === 0 ? (
          <Empty>ยังไม่มีสินทรัพย์ในพอร์ต</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>สินทรัพย์</th>
                  <th>ประเภท</th>
                  <th className="num">จำนวน</th>
                  <th className="num">ต้นทุนเฉลี่ย (฿)</th>
                  <th className="num">ราคาล่าสุด</th>
                  <th className="num">มูลค่า</th>
                  <th className="num">กำไรยังไม่รับรู้</th>
                  <th className="num">รับรู้แล้ว + ปันผล</th>
                  <th className="num">น้ำหนัก</th>
                  <th className="num">มูลค่าที่เหมาะสม</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.assetId}>
                    <td>
                      <Link href={`/holdings/${p.assetId}`} className="font-medium text-accent">{p.symbol}</Link>
                      <div className="text-xs text-muted">{p.name}</div>
                    </td>
                    <td className="text-xs">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: ASSET_CLASS_COLOR[p.assetClass] }} />
                      {ASSET_CLASS_LABEL[p.assetClass]}
                    </td>
                    <td className="num">{fmtQty(p.quantity)}</td>
                    <td className="num">{fmtNum(p.avgCostThb)}</td>
                    <td className="num">
                      {fmtNum(p.lastPrice)} <span className="text-xs text-muted">{p.currency}</span>
                      <div className="text-[11px] text-muted">{p.lastPriceDate ?? "ราคาซื้อ"}</div>
                      <PriceBadges p={p} />
                    </td>
                    <td className="num">{fmtThb(p.marketValueThb)}</td>
                    <td className={`num ${signClass(p.unrealizedPnlThb)}`}>
                      {fmtThb(p.unrealizedPnlThb)}
                      <div className="text-[11px]">{fmtPctRaw(p.unrealizedPnlPct)}</div>
                    </td>
                    <td className={`num ${signClass(p.realizedPnlThb + p.incomeThb)}`}>{fmtThb(p.realizedPnlThb + p.incomeThb)}</td>
                    <td className="num">{fmtPctRaw(p.weightPct)}</td>
                    <td className="num">
                      <ValuationCell v={vals.get(p.symbol)} price={p.lastPrice} symbol={p.symbol} cls={p.assetClass} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} className="text-muted">เงินสดในพอร์ต</td>
                  <td className="num">{fmtThb(summary.cashThb)}</td>
                  <td colSpan={2} />
                  <td className="num">{fmtPctRaw(summary.totalValueThb ? (summary.cashThb / summary.totalValueThb) * 100 : 0)}</td>
                  <td />
                </tr>
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={5}>รวม</td>
                  <td className="num">{fmtThb(summary.totalValueThb)}</td>
                  <td className={`num ${signClass(summary.totalPnlThb)}`} colSpan={2}>P&amp;L รวม {fmtThb(summary.totalPnlThb)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Section>

      {(closed.length > 0 || untouched.length > 0) && (
        <Section title="สินทรัพย์อื่น ๆ (ขายหมดแล้ว / ยังไม่ได้ซื้อ)">
          <div className="flex flex-wrap gap-2 text-sm">
            {[...closed.map((p) => ({ id: p.assetId, symbol: p.symbol, extra: `รับรู้ ${fmtThb(p.realizedPnlThb + p.incomeThb)}` })), ...untouched.map((a) => ({ id: a.id, symbol: a.symbol, extra: "" }))].map((a) => (
              <Link key={a.id} href={`/holdings/${a.id}`} className="btn-ghost">
                {a.symbol} {a.extra && <span className="text-xs text-muted">{a.extra}</span>}
              </Link>
            ))}
          </div>
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="เพิ่มสินทรัพย์">
          <AddAssetForm />
        </Section>
        <Section title="บันทึกราคาเอง (พันธบัตร / กองทุน / ราคาที่ดึงไม่ได้)">
          {assets.length ? <AddPriceForm assets={assets} /> : <Empty>เพิ่มสินทรัพย์ก่อน</Empty>}
        </Section>
      </div>

      <Section title="ดึงราคาย้อนหลัง (Historical sync)">
        <ActionForm action={syncHistoryAction} className="grid gap-3 sm:grid-cols-6" resetOnSuccess={false} submitLabel="ดึงราคา">
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
              <input type="checkbox" name="dryRun" defaultChecked className="accent-[var(--accent)]" /> ทดลองก่อน (ไม่บันทึก)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="overwrite" className="accent-[var(--accent)]" /> เขียนทับราคาที่มีอยู่
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="adjusted" className="accent-[var(--accent)]" /> เก็บราคาปรับปันผล (adjusted) แยกด้วย
            </label>
          </div>
        </ActionForm>
        <p className="mt-2 text-xs text-muted">
          ดึงจาก Yahoo (หุ้น/ทอง/ดัชนี/USDTHB) และ ก.ล.ต. (NAV กองทุน ≤ {400} วัน) · ไม่เขียนทับราคาเดิมถ้าไม่เลือก · สัญลักษณ์ที่ยังไม่มีในรายการจะถูกรายงาน ไม่สร้างให้ · Claude/ChatGPT ใช้เครื่องมือ sync_historical_prices ได้เหมือนกัน
        </p>
      </Section>
    </>
  );
}

function ValuationCell({ v, price, symbol, cls }: { v?: { average: number | null; count: number }; price: number | null; symbol: string; cls: string }) {
  if (v?.average != null) {
    const up = price ? v.average / price - 1 : null;
    return (
      <Link href={`/valuation/stock/${symbol}`} className="hover:underline" title={`เฉลี่ยจาก ${v.count} valuation`}>
        {fmtNum(v.average)}
        <div className={`text-[11px] ${signClass(up)}`}>{up != null ? `${up >= 0 ? "+" : ""}${(up * 100).toFixed(1)}%` : ""}</div>
      </Link>
    );
  }
  if (cls === "thai_stock" || cls === "us_stock")
    return <Link href={`/valuation/new?symbol=${symbol}`} className="text-xs text-accent">ประเมิน →</Link>;
  if (cls === "bond") return <Link href="/bonds" className="text-xs text-accent">YTM →</Link>;
  return <span className="text-muted">–</span>;
}
