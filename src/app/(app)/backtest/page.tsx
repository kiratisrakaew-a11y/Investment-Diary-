import { listAssets } from "@/server/services/assets";
import { loadPriceHistory } from "@/server/services/prices";
import { BacktestClient } from "@/components/BacktestClient";
import { Empty, PageHeader } from "@/components/ui";

export default async function BacktestPage() {
  const [assets, prices] = await Promise.all([listAssets(), loadPriceHistory()]);
  const usable = assets
    .filter((a) => !a.archivedAt && a.assetClass !== "cash" && (prices.get(a.id)?.length ?? 0) >= 2)
    .map((a) => {
      const p = prices.get(a.id)!;
      return { symbol: a.symbol, assetClass: a.assetClass, from: p[0][0], to: p[p.length - 1][0], count: p.length };
    });
  return (
    <>
      <PageHeader title="Backtest พอร์ต (walk-forward)" subtitle="ทดสอบกลยุทธ์ย้อนหลังโดยใช้เฉพาะข้อมูลที่มี ณ วันนั้น หักต้นทุนการซื้อขาย และวัดผลด้วยเครื่องมือเดียวกับหน้าผลการดำเนินงาน" />
      {usable.length ? <BacktestClient assets={usable} /> : <Empty>ยังไม่มีสินทรัพย์ที่มีประวัติราคา — ดึงราคาย้อนหลังในหน้าสินทรัพย์ก่อน</Empty>}
    </>
  );
}
