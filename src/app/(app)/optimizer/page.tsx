import { loadUniverse, universeYears } from "@/server/services/optimizer";
import { OptimizerClient } from "@/components/OptimizerClient";
import { OptimizerTabs } from "@/components/OptimizerTabs";
import { ModelComparisonClient } from "@/components/ModelComparisonClient";
import { Empty, PageHeader } from "@/components/ui";
import { BasisBenchmarkPicker, BasisSummary } from "@/components/BasisBenchmarkPicker";
import { listBenchmarks } from "@/server/services/benchmarks";
import { getSettings } from "@/server/services/settings";
import { isReturnBasis } from "@/lib/finance/price-basis";
import { BenchmarkError } from "@/lib/finance/benchmark-resolve";
import { WindowBanner, WindowPicker } from "@/components/WindowPicker";
import { CoverageTable } from "@/components/CoverageTable";
import { WindowError, windowFromPageQuery, type WindowPreset } from "@/lib/finance/window";
import Link from "next/link";
import { listAssets } from "@/server/services/assets";
import { ASSET_CLASS_LABEL } from "@/lib/format";
import { UniversePicker } from "@/components/UniversePicker";
import { pageBenchmark, parseSelection, periodUnit } from "@/lib/finance/universe-selection";

export default async function OptimizerPage({
  searchParams,
}: {
  searchParams: Promise<{ basis?: string; bench?: string; win?: string; from?: string; to?: string; mu?: string; hp?: string; ack?: string; sel?: string }>;
}) {
  const q = await searchParams;
  const [settings, benchmarks] = await Promise.all([getSettings(), listBenchmarks()]);
  // PRICE_BASIS_BENCHMARK_SPEC F3: ?basis=…&bench=… override Settings for this page; μ/Σ are recomputed server-side.
  const returnBasis = isReturnBasis(q.basis) ? q.basis : settings.defaultReturnBasis;
  // spec-mpt-selected-universe 8: on total_return an unchosen index becomes "auto" (a total-return index when stored).
  const benchmark = pageBenchmark(returnBasis, q.bench?.trim() || settings.defaultBenchmark);
  const basis: { returnBasis: typeof returnBasis; benchmark: string; window?: unknown } = { returnBasis, benchmark };
  // spec-lookback-window: ?win=…&from=…&to=…&mu=… (data period) and ?hp=… (history policy) for this page.
  const winQ = windowFromPageQuery(q);
  const historyPolicy = q.hp === "drop_short" || q.hp === "pairwise" || q.hp === "common" ? q.hp : undefined;
  const winValue = {
    preset: (winQ.request?.preset ?? settings.defaultWindowPreset) as WindowPreset,
    startDate: winQ.request?.startDate,
    endDate: winQ.request?.endDate,
    muPreset: winQ.request?.muWindow?.preset,
  };
  // spec-mpt-selected-universe: the checked assets (?sel=) are the universe — nothing else reaches μ / Σ / β.
  const catalogAssets = (await listAssets()).filter((a) => a.assetClass !== "cash" && !a.archivedAt);
  const catalog = catalogAssets.map((a) => ({ symbol: a.symbol, name: a.name, assetClassLabel: ASSET_CLASS_LABEL[a.assetClass], held: false }));
  const selected = parseSelection(q.sel, catalog.map((c) => c.symbol));
  let u: Awaited<ReturnType<typeof loadUniverse>> | null = null;
  let benchError: string | null = winQ.error ? `ช่วงข้อมูลไม่ถูกต้อง: ${winQ.error}` : null;
  try {
    // Nothing selected → no run (never a silent fallback to every asset).
    if (selected.length) u = await loadUniverse(undefined, selected, { withSeries: true, returnBasis, benchmark, window: winQ.request, historyPolicy });
  } catch (e) {
    if (e instanceof BenchmarkError) benchError = `${e.message} [${e.code}] — ${e.issue.suggestion}`;
    else if (e instanceof WindowError) benchError = `${e.message} [${e.code}]${e.hint ? ` — ${e.hint}` : ""}`;
    else throw e;
  }
  const withQ = (patch: Record<string, string>) => {
    const sp = new URLSearchParams(Object.entries(q).filter(([, v]) => typeof v === "string") as [string, string][]);
    for (const [k, v] of Object.entries(patch)) sp.set(k, v);
    return `/optimizer?${sp.toString()}`;
  };
  basis.window = winQ.request;
  const insufficient = u?.windowInfo?.quality === "insufficient" && q.ack !== "1";
  const heldSet = new Set(u?.assets.filter((a) => a.held).map((a) => a.symbol) ?? []);
  for (const c of catalog) c.held = heldSet.has(c.symbol);
  const picker = (
    <div className="card space-y-2">
      <UniversePicker catalog={catalog} selected={selected} skipped={u?.skipped ?? []} />
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
      <WindowPicker mode="query" value={winValue} />
      {u && <BasisSummary priceBasis={u.priceBasis} benchmark={u.benchmark} />}
      {u && <WindowBanner info={u.windowInfo} />}
      {u && <CoverageTable rows={u.coverage} />}
      {historyPolicy && <p className="text-xs text-muted">historyPolicy: {historyPolicy}</p>}
    </div>
  );
  return (
    <>
      <PageHeader
        title="จัดพอร์ตตาม Modern Portfolio Theory"
        subtitle="Efficient frontier, tangency portfolio, น้ำหนักที่แนะนำ และการเปรียบเทียบโมเดลแบบ Out-of-Sample"
      />
      {insufficient ? (
        <>
          {picker}
          <section className="card space-y-2 border-l-4 border-l-neg" data-testid="window-insufficient">
            <h2 className="text-base font-semibold text-neg">ข้อมูลไม่พอสำหรับจำนวนสินทรัพย์นี้</h2>
            <p className="text-sm">
              มีเพียง {u!.windowInfo!.obsPerAsset.toFixed(1)} งวดต่อสินทรัพย์ (ควร ≥ {settings.minObsPerAsset}) — Σ และน้ำหนักที่ได้ไม่น่าเชื่อถือ
              {u!.windowInfo!.limitedBy.length ? ` · ช่วงถูกจำกัดโดย ${u!.windowInfo!.limitedBy.map((l) => `${l.symbol} (เริ่ม ${l.firstDate})`).join(", ")}` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Link className="btn" href={withQ({ hp: "drop_short" })}>
                ตัดตัวที่ประวัติสั้น (drop_short)
              </Link>
              <Link className="btn-ghost" href={withQ({ ack: "1" })}>
                เข้าใจแล้ว ดูผลต่อ
              </Link>
            </div>
          </section>
        </>
      ) : !u || !u.ok ? (
        <>
          {picker}
          <Empty>
            {benchError ?? (selected.length === 0 ? "ยังไม่ได้เลือกสินทรัพย์ — เลือกอย่างน้อย 2 ตัวเพื่อคำนวณ" : u?.reason)}
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
                years={universeYears(u)}
                muCap={settings.muCapPct != null ? settings.muCapPct / 100 : null}
                erp={u.equityRiskPremium} period={`${u.from} → ${u.to} (${u.observations} ${periodUnit(u.frequency)})`} scenarios={u.series?.returns} />
            }
            comparison={<ModelComparisonClient assets={catalogAssets.map((a) => ({ symbol: a.symbol, assetClass: a.assetClass }))} defaultIncluded={selected} basis={basis} benchmarks={benchmarks} initialWindow={winValue} />}
          />
        </>
      )}
    </>
  );
}
