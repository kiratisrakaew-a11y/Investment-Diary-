import { listAssets } from "@/server/services/assets";
import { loadPriceHistory } from "@/server/services/prices";
import { BacktestClient } from "@/components/BacktestClient";
import { EmptyState, PageHeader } from "@/components/ui";
import { EmptyIcon } from "@/components/icons";
import { ClockCounterClockwise } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { getSettings } from "@/server/services/settings";
import { listBenchmarks } from "@/server/services/benchmarks";
import type { WindowPreset } from "@/lib/finance/window";

export default async function BacktestPage() {
  const [assets, prices, settings, benchmarks] = await Promise.all([listAssets(), loadPriceHistory(), getSettings(), listBenchmarks()]);
  const usable = assets
    .filter((a) => !a.archivedAt && a.assetClass !== "cash" && (prices.get(a.id)?.length ?? 0) >= 2)
    .map((a) => {
      const p = prices.get(a.id)!;
      return { symbol: a.symbol, assetClass: a.assetClass, from: p[0][0], to: p[p.length - 1][0], count: p.length };
    });
  return (
    <div className="space-y-6">
      <PageHeader title="Backtest พอร์ต (walk-forward)" subtitle="ทดสอบกลยุทธ์ย้อนหลังโดยใช้เฉพาะข้อมูลที่มี ณ วันนั้น หักต้นทุนการซื้อขาย และวัดผลด้วยเครื่องมือเดียวกับหน้าผลการดำเนินงาน" />
      {usable.length ? <BacktestClient assets={usable} initialBasis={{ basis: settings.defaultReturnBasis, bench: settings.defaultBenchmark }} benchmarks={benchmarks} initialWindow={{ preset: settings.defaultWindowPreset as WindowPreset }} /> : <EmptyState icon={<EmptyIcon icon={ClockCounterClockwise} />} title="ยังไม่มีสินทรัพย์ที่มีประวัติราคา" description="ดึงราคาย้อนหลังในหน้าสินทรัพย์ก่อน แล้วกลับมาทดสอบกลยุทธ์" action={<Link href="/holdings" className="btn">ไปที่หน้าสินทรัพย์</Link>} />}
    </div>
  );
}
