import { listAssets } from "@/server/services/assets";
import { FactorStrategyPanel } from "@/components/FactorStrategyPanel";
import { PageHeader } from "@/components/ui";
import { getSettings } from "@/server/services/settings";

export default async function FactorsPage() {
  const [assets, settings] = await Promise.all([listAssets(), getSettings()]);
  const symbols = assets.filter((a) => !a.archivedAt && ["thai_stock", "us_stock", "fund"].includes(a.assetClass)).map((a) => a.symbol);
  return (
    <div className="space-y-6">
      <PageHeader
        title="กลยุทธ์ปัจจัย (Factor)"
        subtitle="Value · Quality · Momentum 12–1 · Multi-factor — สัญญาณจากข้อมูลที่รู้ ณ วันที่เลือกเท่านั้น ใช้ backtest และการปรับพอร์ตชุดเดียวกับกลยุทธ์อื่น"
      />
      <FactorStrategyPanel symbols={symbols} initialBasis={settings.defaultReturnBasis} />
    </div>
  );
}
