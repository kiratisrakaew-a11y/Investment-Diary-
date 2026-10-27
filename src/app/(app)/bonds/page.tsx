import { BondLadderPanel } from "@/components/BondLadderPanel";
import Link from "next/link";
import { bondHoldings } from "@/server/services/bonds";
import { BondCalculator } from "@/components/BondCalculator";
import { Empty, PageHeader, Section, Stat } from "@/components/ui";
import { fmtNum, fmtPct, fmtThb } from "@/lib/format";
import { CreditProfileForm } from "@/components/CreditProfileForm";
import { listAssets } from "@/server/services/assets";
import { today } from "@/lib/validation";
import { compact } from "@/lib/explain-data";

type SP = Promise<{ maturity?: string; coupon?: string; price?: string }>;

export default async function BondsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const [{ settlement, bonds, portfolio }, assets] = await Promise.all([bondHoldings(), listAssets()]);
  const assetBySymbol = new Map(assets.map((a) => [a.symbol, a]));
  return (
    <>
      <PageHeader title="พันธบัตรและหุ้นกู้" subtitle="ราคา ↔ YTM / YTC / YTW, accrued interest ตาม day count ของตราสาร, duration, convexity, Z-spread และ horizon return" />

      <Section title="พันธบัตรในพอร์ต" explain={{ data: compact({ settlement, พอร์ตพันธบัตร: portfolio, รายตัว: bonds.map((b) => ({ symbol: b.symbol, ราคา: b.lastPrice, analytics: b.analytics ? { ...b.analytics, cashflows: undefined } : null })) }), hint: "YTM = ผลตอบแทนต่อปีถ้าถือจนครบกำหนด; modified duration = ราคาลดลงประมาณ D% เมื่อดอกเบี้ยขึ้น 1%" }}>
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
              คำนวณ ณ วันนี้ด้วยคูปองปกติ (ไม่มี stub) และความถี่/day count ที่บันทึกไว้ในสินทรัพย์
              {bonds.some((b) => b.assumed.length > 0) &&
                ` · ใช้ค่าสมมติสำหรับ ${bonds
                  .filter((b) => b.assumed.length > 0)
                  .map((b) => `${b.symbol} (${b.assumed.join(", ")})`)
                  .join("; ")} — ระบุเงื่อนไขจริงได้ในหน้าสินทรัพย์`}{" "}
              · Yield รวมค่าชดเชยความเสี่ยงเครดิตและสภาพคล่อง ไม่ใช่ผลตอบแทนปลอดความเสี่ยง
            </p>
          </div>
        )}
      </Section>

      {bonds.length > 0 && (
        <Section title="ความเสี่ยงเครดิต (credit)" explain={{ data: compact(bonds.map((b) => ({ symbol: b.symbol, credit: b.credit }))), hint: "PD = โอกาสผิดนัด, LGD = ส่วนที่เสียเมื่อผิดนัด, Expected loss = PD × LGD × มูลค่า; ค่ามาจากที่ผู้ใช้กรอก" }}>
          <div className="space-y-4">
            {bonds.map((b) => {
              const c = b.credit;
              const a = assetBySymbol.get(b.symbol);
              return (
                <details key={b.id} className="rounded border border-border/60 p-3" open={c?.status === "ok"}>
                  <summary className="cursor-pointer text-sm">
                    <span className="font-medium">{b.symbol}</span>
                    <span className="ml-2 text-muted">
                      {c ? (c.rating === "unrated" ? "unrated" : `${c.rating.rating}${c.rating.agency ? ` (${c.rating.agency}${c.rating.date ? ` ${c.rating.date}` : ""})` : ""}`) : "–"}
                      {a?.issuer ? ` · ผู้ออก ${a.issuer}` : ""}
                      {c?.status === "ok" && c.term ? ` · PV(EL) ${fmtNum(c.term.pvExpectedLoss, 3)} ต่อ 100` : c ? " · ยังไม่มีข้อมูล PD/LGD" : ""}
                    </span>
                  </summary>
                  {c ? (
                    <div className="mt-3 space-y-3 text-sm">
                      {c.status === "ok" && c.term && c.oneYear ? (
                        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                          <Stat label="PD 1 ปี" value={fmtPct(c.oneYear.pd, 3)} />
                          <Stat label="LGD" value={fmtPct(c.oneYear.lgd, 1)} />
                          <Stat label="EL 1 ปี (ต่อ 100)" value={fmtNum(c.oneYear.expectedLoss, 3)} sub={`EAD ${fmtNum(c.oneYear.ead, 2)}`} />
                          <Stat label="PD ตลอดอายุ" value={fmtPct(c.term.lifetimePd, 2)} />
                          <Stat label="PV(EL) ตลอดอายุ" value={fmtNum(c.term.pvExpectedLoss, 3)} sub={`มูลค่าตามสัญญา ${fmtNum(c.term.contractualPv, 2)}`} />
                          <Stat label="มูลค่าหลังหักความเสี่ยงเครดิต" value={fmtNum(c.term.creditAdjustedValue, 2)} sub="คาดหวัง (ไม่ใช่ราคาตลาด)" />
                        </div>
                      ) : (
                        <p className="text-xs text-neg">{c.status === "invalid" ? c.issues.map((i) => i.message).join(" · ") : `ไม่มีข้อมูล: ${c.required.join(", ")}`}</p>
                      )}
                      <p className="text-xs text-muted">
                        {"zSpread" in c.spread
                          ? `Z-spread ${fmtPct(c.spread.zSpread, 3)} · spread DV01 ${fmtNum(c.spread.spreadDv01, 4)} ต่อ 100 · spread duration ${fmtNum(c.spread.spreadDuration, 2)} — ${c.spread.basis}`
                          : c.spread.unavailable}
                      </p>
                      {c.status === "ok" && (
                        <p className="text-xs text-muted">
                          {c.oneYear?.basis} · ส่วนลด: {c.term?.discount} · PD: {c.provenance.pdType} ({c.provenance.pdSource}, {c.provenance.pdAsOf}) · LGD: {c.provenance.lgdSource} ({c.provenance.lgdAsOf})
                          {c.issues.length > 0 && ` · ⚠️ ${c.issues.map((i) => i.message).join(" · ")}`}
                        </p>
                      )}
                      <CreditProfileForm symbol={b.symbol} issuer={a?.issuer ?? null} profile={(a?.credit as never) ?? null} today={today()} />
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted">{b.missing}</p>
                  )}
                </details>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">
            EL = PD × LGD × EAD (เป็นตัววัดความเสี่ยง ไม่ใช่ ECL ทางบัญชี TFRS 9) · PV(EL) = Σ PD ส่วนเพิ่ม × LGD × EAD × DF ตามงวดจ่าย · ไม่นำ EL รายปีไปหักจาก YTM โดยตรง
          </p>
        </Section>
      )}

      <BondCalculator
        key={`${sp.maturity}-${sp.coupon}-${sp.price}`}
        init={{
          settlement,
          maturity: sp.maturity,
          couponRate: sp.coupon ? Number(sp.coupon) / 100 : undefined,
          cleanPrice: sp.price ? Number(sp.price) : undefined,
        }}
      />
      <Section title="บันไดพันธบัตร (Bond ladder)" subtitle="แบ่งเงินให้ครบกำหนดทยอยทุกปี · ใช้ engine ราคาและเครดิตเดิม · เป็นสถานการณ์ล่วงหน้า ไม่ใช่ผลในอดีต">
        <BondLadderPanel />
      </Section>
    </>
  );
}
