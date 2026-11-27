import Link from "next/link";
import { listValuationsGrouped, valueChangedSinceSave } from "@/server/services/valuations";
import { listAssets } from "@/server/services/assets";
import { loadPriceHistory } from "@/server/services/prices";
import { getTimestampPolicy } from "@/server/services/settings";
import { Collapsible, EmptyState, PageHeader } from "@/components/ui";
import { EmptyIcon } from "@/components/icons";
import { Calculator } from "@phosphor-icons/react/ssr";
import { ValuationOverview, type OverviewRow } from "@/components/ValuationOverview";
import { METHOD_LABEL } from "@/lib/format";
import { MODEL_VERSION } from "@/lib/governance";
import { today } from "@/lib/validation";
import { latestConsensusFor } from "@/server/services/consensus";
import { consensusView } from "@/lib/consensus";

export default async function ValuationListPage() {
  const [groups, assets, prices, policy] = await Promise.all([listValuationsGrouped(), listAssets(), loadPriceHistory(), getTimestampPolicy()]);
  const now = today();
  const consensus = await latestConsensusFor(groups.map((g) => g.symbol));
  const assetCurrency = new Map(assets.map((a) => [a.symbol.toUpperCase(), a.currency]));
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
      consensus: (() => {
        const c = consensus.get(g.symbol.toUpperCase());
        if (!c) return null;
        // Upside only against a stored price (not the valuation-time price) and in the same currency.
        const v = consensusView(c, { price: last?.[1] ?? null, priceCurrency: assetCurrency.get(g.symbol.toUpperCase()) ?? null, today: now });
        return { target: v.target, upside: v.upside, asOf: c.asOf, ageDays: v.ageDays, stale: v.stale, source: c.source };
      })(),
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="ประเมินมูลค่าหุ้น"
        subtitle="DCF (FCFF / FCFE), Dividend discount, Residual income, Multiples — รวมทุก valuation ของหุ้นแต่ละตัวไว้ที่เดียว"
        action={<Link href="/valuation/new" className="btn">+ ประเมินมูลค่าใหม่</Link>}
      />
      {groups.length === 0 ? (
        <EmptyState
          icon={<EmptyIcon icon={Calculator} />}
          title="ยังไม่มี valuation"
          description="เริ่มประเมินมูลค่าหุ้นตัวแรก หรือให้ AI ช่วยประเมินให้"
          action={<Link href="/valuation/new" className="btn">+ ประเมินมูลค่าใหม่</Link>}
        />
      ) : (
        <ValuationOverview rows={rows} staleAfterDays={policy.priceMaxGapDays} />
      )}
      {stocks.length > 0 && (
        <Collapsible title="หุ้นที่ยังไม่ได้ประเมิน" meta={`${stocks.length} ตัว`} defaultOpen={groups.length === 0}>
          <div className="flex flex-wrap gap-2 text-sm">
            {stocks.map((a) => (
              <Link key={a.id} href={`/valuation/new?symbol=${a.symbol}`} className="btn-ghost">
                {a.symbol}
              </Link>
            ))}
          </div>
        </Collapsible>
      )}
    </div>
  );
}
