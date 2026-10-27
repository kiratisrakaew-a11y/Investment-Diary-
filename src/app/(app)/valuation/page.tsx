import Link from "next/link";
import { listValuationsGrouped } from "@/server/services/valuations";
import { listAssets } from "@/server/services/assets";
import { loadPriceHistory } from "@/server/services/prices";
import { Badge, Empty, PageHeader, Section } from "@/components/ui";
import { METHOD_LABEL, fmtNum, fmtPct, signClass } from "@/lib/format";

export default async function ValuationListPage() {
  const [groups, assets, prices] = await Promise.all([listValuationsGrouped(), listAssets(), loadPriceHistory()]);
  const latestPrice = (assetId: number | null) => {
    const s = assetId ? prices.get(assetId) : undefined;
    return s?.[s.length - 1]?.[1] ?? null;
  };
  const valued = new Set(groups.map((g) => g.symbol));
  const stocks = assets.filter((a) => (a.assetClass === "thai_stock" || a.assetClass === "us_stock") && !valued.has(a.symbol));

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
            <Link key={a.id} href={`/valuation/new?symbol=${a.symbol}`} className="btn-ghost">{a.symbol}</Link>
          ))}
        </div>
      )}
      <Section title="หุ้นที่ประเมินมูลค่าแล้ว">
        {groups.length === 0 ? (
          <Empty>ยังไม่มี — กด “ประเมินมูลค่าใหม่” หรือให้ AI ช่วยประเมิน</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>หุ้น</th>
                  <th>วิธีที่ใช้ (มูลค่าล่าสุด)</th>
                  <th className="min-w-56">ช่วงมูลค่าเทียบราคา</th>
                  <th className="num">เฉลี่ย / มัธยฐาน</th>
                  <th className="num">ราคาล่าสุด</th>
                  <th className="num" title="เทียบมัธยฐาน — ไม่ถูกดึงด้วยค่าโดดของวิธีเดียว">Upside (มัธยฐาน)</th>
                  <th>ประเมินล่าสุด</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const price = latestPrice(g.assetId) ?? g.latestByMethod[0]?.priceAtValuation ?? null;
                  const up = g.median && price ? g.median / price - 1 : null;
                  return (
                    <tr key={g.symbol}>
                      <td>
                        <Link href={`/valuation/stock/${encodeURIComponent(g.symbol)}`} className="font-medium text-accent">{g.symbol}</Link>
                        <div className="text-[11px] text-muted">{g.count} valuation</div>
                      </td>
                      <td className="whitespace-normal">
                        <div className="flex flex-wrap gap-1">
                          {g.latestByMethod.map((r) => (
                            <Badge key={r.id}>
                              {METHOD_LABEL[r.method]} {fmtNum(r.intrinsicValue)}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td>
                        <RangeBar values={g.latestByMethod.map((r) => ({ label: METHOD_LABEL[r.method], v: r.intrinsicValue }))} price={price} />
                        <div className="mt-1 text-[11px] text-muted tabular-nums">{g.low != null ? `${fmtNum(g.low)} – ${fmtNum(g.high)}` : "–"}</div>
                      </td>
                      <td className="num">
                        <span className="font-semibold">{fmtNum(g.average)}</span>
                        <div className="text-[11px] text-muted">มัธยฐาน {fmtNum(g.median)}</div>
                      </td>
                      <td className="num">{fmtNum(price)}</td>
                      <td className={`num ${signClass(up)}`}>{fmtPct(up, 1)}</td>
                      <td>
                        {g.lastDate}{" "}
                        <Link href={`/valuation/stock/${encodeURIComponent(g.symbol)}`} className="ml-2 text-xs text-accent">ดูทั้งหมด →</Link>
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

/** Latest value of each method as dots on one line, with the market price as a vertical marker. */
function RangeBar({ values, price }: { values: { label: string; v: number | null }[]; price: number | null }) {
  const vs = values.filter((x): x is { label: string; v: number } => x.v != null && Number.isFinite(x.v));
  if (!vs.length) return <span className="text-muted">–</span>;
  const all = [...vs.map((x) => x.v), ...(price != null ? [price] : [])];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pos = (v: number) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100);
  const vmin = Math.min(...vs.map((x) => x.v));
  const vmax = Math.max(...vs.map((x) => x.v));
  return (
    <div className="relative h-5" role="img" aria-label={`ช่วงมูลค่า ${fmtNum(vmin)} ถึง ${fmtNum(vmax)}${price != null ? ` ราคา ${fmtNum(price)}` : ""}`}>
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-panel-2" />
      <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-linear-to-r from-accent/70 to-accent-2/70" style={{ left: `${pos(vmin)}%`, width: `${Math.max(1, pos(vmax) - pos(vmin))}%` }} />
      {vs.map((x) => (
        <span key={x.label} title={`${x.label} ${fmtNum(x.v)}`} className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel-solid bg-accent" style={{ left: `${pos(x.v)}%` }} />
      ))}
      {price != null && <span title={`ราคา ${fmtNum(price)}`} className="absolute top-0 h-5 w-0.5 -translate-x-1/2 rounded bg-text" style={{ left: `${pos(price)}%` }} />}
    </div>
  );
}
