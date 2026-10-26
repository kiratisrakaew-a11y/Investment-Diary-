import Link from "next/link";
import { bondHoldings } from "@/server/services/bonds";
import { BondCalculator } from "@/components/BondCalculator";
import { Empty, PageHeader, Section, Stat } from "@/components/ui";
import { fmtNum, fmtPct, fmtThb } from "@/lib/format";

type SP = Promise<{ maturity?: string; coupon?: string; price?: string }>;

export default async function BondsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { settlement, bonds, portfolio } = await bondHoldings();
  return (
    <>
      <PageHeader title="พันธบัตรและหุ้นกู้" subtitle="ราคา ↔ YTM / YTC / YTW, accrued interest ตาม day count ของตราสาร, duration, convexity, Z-spread และ horizon return" />

      <Section title="พันธบัตรในพอร์ต">
        {portfolio && (
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="มูลค่ารวม" value={fmtThb(portfolio.marketValueThb)} />
            <Stat label="YTM ถัวเฉลี่ย" value={fmtPct(portfolio.ytm)} />
            <Stat label="Modified duration" value={fmtNum(portfolio.modifiedDuration)} sub="ราคาเปลี่ยน ≈ −D × Δy" />
            <Stat label="Convexity" value={fmtNum(portfolio.convexity, 1)} />
          </div>
        )}
        {bonds.length === 0 ? (
          <Empty>ยังไม่มีสินทรัพย์ประเภทพันธบัตร — เพิ่มในหน้าสินทรัพย์พร้อมอัตราคูปอง วันครบกำหนด และมูลค่าที่ตราไว้</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>พันธบัตร</th>
                  <th className="num">คูปอง</th>
                  <th>ครบกำหนด</th>
                  <th className="num">ราคาล่าสุด</th>
                  <th className="num">YTM</th>
                  <th className="num">Current yield</th>
                  <th className="num">Mod. duration</th>
                  <th className="num">มูลค่า</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bonds.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <span className="font-medium">{b.symbol}</span>
                      <div className="text-xs text-muted">{b.name}</div>
                    </td>
                    <td className="num">{b.couponRate != null ? `${b.couponRate}%` : "–"}</td>
                    <td>{b.maturityDate ?? "–"}</td>
                    <td className="num">
                      {fmtNum(b.lastPrice)}
                      <div className="text-[11px] text-muted">{b.lastPriceDate}</div>
                    </td>
                    {b.analytics ? (
                      <>
                        <td className="num font-medium">{fmtPct(b.analytics.ytm, 3)}</td>
                        <td className="num">{fmtPct(b.analytics.currentYield)}</td>
                        <td className="num">{fmtNum(b.analytics.modifiedDuration)}</td>
                      </>
                    ) : (
                      <td colSpan={3} className="text-xs text-muted">{b.missing}</td>
                    )}
                    <td className="num">{fmtThb(b.marketValueThb)}</td>
                    <td>
                      {b.analytics && (
                        <Link
                          className="text-xs text-accent"
                          href={`/bonds?maturity=${b.maturityDate}&coupon=${b.couponRate}&price=${(b.analytics.cleanPrice).toFixed(4)}`}
                        >
                          วิเคราะห์ →
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">
              สมมติฐานสำหรับพันธบัตรในพอร์ต: จ่ายดอกเบี้ยทุก 6 เดือน, คูปองปกติ (ไม่มี stub), accrued แบบ ACT/ACT-ICMA, ชำระราคาวันนี้ — ถ้าตราสารจริงต่างจากนี้ให้ใช้เครื่องคิดด้านล่างตามเงื่อนไขของตราสาร ·
              Yield รวมค่าชดเชยความเสี่ยงเครดิตและสภาพคล่อง ไม่ใช่ผลตอบแทนปลอดความเสี่ยง
            </p>
          </div>
        )}
      </Section>

      <BondCalculator
        key={`${sp.maturity}-${sp.coupon}-${sp.price}`}
        init={{
          settlement,
          maturity: sp.maturity,
          couponRate: sp.coupon ? Number(sp.coupon) / 100 : undefined,
          cleanPrice: sp.price ? Number(sp.price) : undefined,
        }}
      />
    </>
  );
}
