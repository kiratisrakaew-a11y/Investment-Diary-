import { loadUniverse } from "@/server/services/optimizer";
import { OptimizerClient } from "@/components/OptimizerClient";
import { OptimizerTabs } from "@/components/OptimizerTabs";
import { ModelComparisonClient } from "@/components/ModelComparisonClient";
import { Empty, PageHeader } from "@/components/ui";
import { BasisBenchmarkPicker, BasisSummary } from "@/components/BasisBenchmarkPicker";
import { listBenchmarks } from "@/server/services/benchmarks";
import { getSettings } from "@/server/services/settings";
import { isReturnBasis } from "@/lib/finance/price-basis";
import { BenchmarkError } from "@/lib/finance/benchmark-resolve";

export default async function OptimizerPage({
  searchParams,
}: {
  searchParams: Promise<{ basis?: string; bench?: string }>;
}) {
  const q = await searchParams;
  const [settings, benchmarks] = await Promise.all([getSettings(), listBenchmarks()]);
  // PRICE_BASIS_BENCHMARK_SPEC F3: ?basis=…&bench=… override Settings for this page; μ/Σ are recomputed server-side.
  const returnBasis = isReturnBasis(q.basis) ? q.basis : settings.defaultReturnBasis;
  const benchmark = q.bench?.trim() || settings.defaultBenchmark;
  const basis = { returnBasis, benchmark };
  let u: Awaited<ReturnType<typeof loadUniverse>> | null = null;
  let benchError: string | null = null;
  try {
    u = await loadUniverse(undefined, undefined, { withSeries: true, returnBasis, benchmark });
  } catch (e) {
    if (!(e instanceof BenchmarkError)) throw e;
    benchError = `${e.message} [${e.code}] — ${e.issue.suggestion}`;
  }
  const picker = (
    <div className="card space-y-2">
      <BasisBenchmarkPicker
        mode="query"
        value={{ basis: returnBasis, bench: benchmark }}
        benchmarks={benchmarks}
        adjCoverage={
          u && returnBasis === "total_return" && u.priceBasis
            ? {
                complete: u.assets.length,
                incomplete: u.priceBasis.excluded.length,
                missing: u.priceBasis.excluded.map((x) => x.symbol),
              }
            : undefined
        }
      />
      {u && <BasisSummary priceBasis={u.priceBasis} benchmark={u.benchmark} />}
    </div>
  );
  return (
    <>
      <PageHeader
        title="จัดพอร์ตตาม Modern Portfolio Theory"
        subtitle="Efficient frontier, tangency portfolio, น้ำหนักที่แนะนำ และการเปรียบเทียบโมเดลแบบ Out-of-Sample"
      />
      {!u || !u.ok ? (
        <>
          {picker}
          <Empty>
            {benchError ?? u?.reason}
            {u && u.skipped.length > 0 && <div className="mt-2 text-xs">{u.skipped.map((s) => `${s.symbol}: ${s.reason}`).join(" · ")}</div>}
          </Empty>
        </>
      ) : (
        <>
          {u.covarianceWarnings.map((w) => (
            <p key={w} className="text-xs text-warn">⚠️ {w}</p>
          ))}
          {u.skipped.length > 0 && (
            <p className="text-xs text-muted">ไม่รวม: {u.skipped.map((s) => `${s.symbol} (${s.reason})`).join(", ")}</p>
          )}
          <OptimizerTabs
            picker={picker}
            optimizer={
              <OptimizerClient
                assets={u.assets}
                cov={u.cov}
                covShrunk={u.covShrunk}
                shrinkage={u.shrinkage}
                periodsPerYear={u.periodsPerYear}
                rf={u.riskFree}
                rfInfo={u.riskFreeInfo}
                basis={basis}
                erp={u.equityRiskPremium} period={`${u.from} → ${u.to} (${u.observations} วัน)`} scenarios={u.series?.returns} />
            }
            comparison={<ModelComparisonClient assets={u.assets.map((a) => ({ symbol: a.symbol, assetClass: a.assetClass }))} />}
          />
        </>
      )}
    </>
  );
}
