import Link from "next/link";
import { listValuations } from "@/server/services/valuations";
import { listAssets } from "@/server/services/assets";
import { loadPriceHistory } from "@/server/services/prices";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Badge, Empty, PageHeader, Section } from "@/components/ui";
import { deleteValuationAction } from "./actions";
import { METHOD_LABEL, fmtNum, fmtPct, signClass } from "@/lib/format";

export default async function ValuationListPage() {
  const [rows, assets, prices] = await Promise.all([listValuations(), listAssets(), loadPriceHistory()]);
  const latestPrice = (assetId: number | null) => {
    const s = assetId ? prices.get(assetId) : undefined;
    return s?.[s.length - 1]?.[1] ?? null;
  };
  const stocks = assets.filter((a) => a.assetClass === "thai_stock" || a.assetClass === "us_stock");

  return (
    <>
      <PageHeader
        title="ประเมินมูลค่าหุ้น"
        subtitle="DCF (FCFF / FCFE), Dividend discount, Residual income, Multiples — ปรับสมมติฐานได้ทุกตัว"
        action={<Link href="/valuation/new" className="btn">+ ประเมินมูลค่าใหม่</Link>}
      />
      {stocks.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="self-center text-xs text-muted">เริ่มเร็ว:</span>
          {stocks.map((a) => (
            <Link key={a.id} href={`/valuation/new?symbol=${a.symbol}`} className="btn-ghost">{a.symbol}</Link>
          ))}
        </div>
      )}
      <Section title="Valuation ที่บันทึกไว้">
        {rows.length === 0 ? (
          <Empty>ยังไม่มี — กด “ประเมินมูลค่าใหม่” หรือให้ AI ที่ปรึกษาช่วยประเมิน</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>สินทรัพย์</th>
                  <th>วิธี</th>
                  <th>Scenario</th>
                  <th className="num">มูลค่าที่เหมาะสม</th>
                  <th className="num">ราคา ณ วันประเมิน</th>
                  <th className="num">ราคาล่าสุด</th>
                  <th className="num">Upside ปัจจุบัน</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const now = latestPrice(v.assetId);
                  const up = v.intrinsicValue && now ? v.intrinsicValue / now - 1 : null;
                  return (
                    <tr key={v.id}>
                      <td>{v.date}</td>
                      <td className="font-medium">
                        <Link href={`/valuation/${v.id}`} className="text-accent">{v.symbol}</Link>
                      </td>
                      <td>
                        <Badge>{METHOD_LABEL[v.method]}</Badge> {v.source !== "web" && <Badge>{v.source}</Badge>}
                      </td>
                      <td className="max-w-48 truncate">{v.title}</td>
                      <td className="num">{fmtNum(v.intrinsicValue)}</td>
                      <td className="num">{fmtNum(v.priceAtValuation)}</td>
                      <td className="num">{fmtNum(now)}</td>
                      <td className={`num ${signClass(up)}`}>{fmtPct(up, 1)}</td>
                      <td>
                        <ConfirmButton onConfirm={deleteValuationAction.bind(null, v.id)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
