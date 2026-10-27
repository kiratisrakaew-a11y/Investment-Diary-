import Link from "next/link";
import { listValuationsGrouped, valueChangedSinceSave } from "@/server/services/valuations";
import { listAssets } from "@/server/services/assets";
import { loadPriceHistory } from "@/server/services/prices";
import { getTimestampPolicy } from "@/server/services/settings";
import { Empty, PageHeader } from "@/components/ui";
import { ValuationOverview, type OverviewRow } from "@/components/ValuationOverview";
import { METHOD_LABEL } from "@/lib/format";
import { MODEL_VERSION } from "@/lib/governance";
import { today } from "@/lib/validation";

export default async function ValuationListPage() {
  const [groups, assets, prices, policy] = await Promise.all([listValuationsGrouped(), listAssets(), loadPriceHistory(), getTimestampPolicy()]);
  const now = today();
  const valued = new Set(groups.map((g) => g.symbol));
  const stocks = assets.filter((a) => (a.assetClass === "thai_stock" || a.assetClass === "us_stock") && !valued.has(a.symbol));
  const rows: OverviewRow[] = groups.map((g) => {
    const series = g.assetId ? prices.get(g.assetId) : undefined;
    const last = series?.[series.length - 1];
    const price = last?.[1] ?? g.latestByMethod[0]?.priceAtValuation ?? null;
    return {
      symbol: g.symbol,
      count: g.count,
      methods: g.latestByMethod.map((r) => ({ id: r.id, label: METHOD_LABEL[r.method] ?? r.method, value: r.intrinsicValue })),
      low: g.low,
      high: g.high,
      average: g.average,
      median: g.median,
      price,
      priceDate: last?.[0] ?? null,
      priceAgeDays: last ? Math.round((Date.parse(now) - Date.parse(last[0])) / 86_400_000) : null,
      upside: g.median && price ? g.median / price - 1 : null,
      lastDate: g.lastDate,
      changedCount: g.latestByMethod.filter((r) => (r.result as { modelVersion?: string } | null)?.modelVersion !== MODEL_VERSION && valueChangedSinceSave(r) !== false).length,
    };
  });

  return (
    <>
      <PageHeader
        title="ประเมินมูลค่าหุ้น"
        subtitle="DCF (FCFF / FCFE), Dividend discount, Residual income, Multiples — รวมทุก valuation ของหุ้นแต่ละตัวไว้ที่เดียว"
        action={<Link href="/valuation/new" className="btn">+ ประเมินมูลค่าใหม่</Link>}
      />
      {stocks.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="self-center text-xs text-muted">ยังไม่ได้ประเมิน:</span>
          {stocks.map((a) => (
            <Link key={a.id} href={`/valuation/new?symbol=${a.symbol}`} className="btn-ghost">
              {a.symbol}
            </Link>
          ))}
        </div>
      )}
      {groups.length === 0 ? <Empty>ยังไม่มี — กด “ประเมินมูลค่าใหม่” หรือให้ AI ช่วยประเมิน</Empty> : <ValuationOverview rows={rows} staleAfterDays={policy.priceMaxGapDays} />}
    </>
  );
}
