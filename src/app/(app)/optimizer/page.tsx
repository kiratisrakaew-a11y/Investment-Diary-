import { loadUniverse } from "@/server/services/optimizer";
import { OptimizerClient } from "@/components/OptimizerClient";
import { Empty, PageHeader } from "@/components/ui";

export default async function OptimizerPage() {
  const u = await loadUniverse(undefined, undefined, { withSeries: true });
  return (
    <>
      <PageHeader
        title="จัดพอร์ตตาม Modern Portfolio Theory"
        subtitle="Efficient frontier, tangency portfolio, complete portfolio ตาม risk aversion และน้ำหนักที่แนะนำ"
      />
      {!u.ok ? (
        <Empty>
          {u.reason}
          {u.skipped.length > 0 && <div className="mt-2 text-xs">{u.skipped.map((s) => `${s.symbol}: ${s.reason}`).join(" · ")}</div>}
        </Empty>
      ) : (
        <>
          {u.covarianceWarnings.map((w) => (
            <p key={w} className="text-xs text-warn">⚠️ {w}</p>
          ))}
          {u.skipped.length > 0 && (
            <p className="text-xs text-muted">ไม่รวม: {u.skipped.map((s) => `${s.symbol} (${s.reason})`).join(", ")}</p>
          )}
          <OptimizerClient
            assets={u.assets}
            cov={u.cov}
            covShrunk={u.covShrunk}
            shrinkage={u.shrinkage}
            periodsPerYear={u.periodsPerYear}
            rf={u.riskFree}
            rfInfo={u.riskFreeInfo}
            erp={u.equityRiskPremium} period={`${u.from} → ${u.to} (${u.observations} วัน)`} scenarios={u.series?.returns} />
        </>
      )}
    </>
  );
}
