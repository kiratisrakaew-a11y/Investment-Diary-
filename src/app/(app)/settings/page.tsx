import { headers } from "next/headers";
import { getSettings, getTargets, getTimestampPolicy, getTradingCosts, getYieldCurve } from "@/server/services/settings";
import { YieldCurveForm } from "@/components/YieldCurveForm";
import { today } from "@/lib/validation";
import { ActionForm } from "@/components/ActionForm";
import { CopyBlock } from "@/components/CopyBlock";
import { PageHeader, Section } from "@/components/ui";
import { saveSettingsAction, saveTargetsAction, saveTimestampPolicyAction, saveTradingCostsAction } from "../actions";
import { ASSET_CLASSES } from "@/lib/finance/allocation";
import { ASSET_CLASS_LABEL } from "@/lib/format";
import { GPT_INSTRUCTIONS } from "@/lib/gpt-instructions";
import { MODEL_VERSION, marketInputProvenance } from "@/lib/governance";
import Link from "next/link";

export default async function SettingsPage() {
  const [settings, targets, h, costs, curve, tsPolicy] = await Promise.all([getSettings(), getTargets(), headers(), getTradingCosts(), getYieldCurve(), getTimestampPolicy()]);
  const prov = marketInputProvenance(settings);
  const tag = (p: { illustrative: boolean; label: string }) => (
    <span className={`ml-1 rounded px-1 text-[11px] ${p.illustrative ? "bg-neg/10 text-neg" : "bg-pos/10 text-pos"}`}>{p.illustrative ? "ค่าตัวอย่าง" : "มีแหล่งที่มา"}</span>
  );
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;

  return (
    <>
      <PageHeader title="ตั้งค่า" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="สมมติฐานทางการเงิน">
          <ActionForm action={saveSettingsAction} className="space-y-3" resetOnSuccess={false}>
            <div>
              <label className="label">
                Risk-free rate (% ต่อปี){tag(prov.riskFree)} — ใช้สกุลเงินและอายุใกล้กับกระแสเงินสด (DCF เงินบาทระยะยาว → พันธบัตรรัฐบาลไทยระยะยาว)
              </label>
              <input name="riskFreeRate" type="number" step="0.01" className="input" defaultValue={settings.riskFreeRate} />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <input name="rfSource" className="input" placeholder="แหล่งที่มา เช่น ThaiBMA" defaultValue={settings.rfSource ?? ""} />
                <input name="rfSeries" className="input" placeholder="ชุดข้อมูล เช่น พันธบัตรรัฐบาล 10 ปี" defaultValue={settings.rfSeries ?? ""} />
                <input name="rfAsOf" type="date" className="input" defaultValue={settings.rfAsOf ?? ""} />
              </div>
            </div>
            <div>
              <label className="label">
                Equity risk premium (% ต่อปี){tag(prov.erp)} — ERP แบบคาดการณ์ (forward-looking) ไม่ใช่ผลตอบแทนตลาดในอดีต
              </label>
              <input name="equityRiskPremium" type="number" step="0.1" className="input" defaultValue={settings.equityRiskPremium} />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input name="erpSource" className="input" placeholder="แหล่งที่มา เช่น Damodaran ม.ค. 2026 (Thailand)" defaultValue={settings.erpSource ?? ""} />
                <input name="erpAsOf" type="date" className="input" defaultValue={settings.erpAsOf ?? ""} />
              </div>
              <p className="mt-1 text-xs text-muted">แหล่งที่มาและวันที่จะถูกบันทึกลงใน valuation ใหม่ทุกครั้ง · เว้นว่าง = ค่าตัวอย่าง</p>
            </div>
            <div>
              <label className="label">ดัชนีอ้างอิง (สัญลักษณ์ Yahoo) — ^SET.BK = SET Index, ^SET50.BK, ^GSPC = S&amp;P 500</label>
              <input name="benchmarkSymbol" className="input" defaultValue={settings.benchmarkSymbol} />
            </div>
            <div>
              <label className="label">ประเภทดัชนีอ้างอิง — ^SET.BK จาก Yahoo เป็นดัชนีราคา (ไม่รวมปันผล)</label>
              <select name="benchmarkKind" className="input" defaultValue={settings.benchmarkKind}>
                <option value="price_index">ดัชนีราคา (price index)</option>
                <option value="total_return">ดัชนีผลตอบแทนรวม (total return, เช่น SET TRI)</option>
              </select>
            </div>
            <div>
              <label className="label">นโยบายเงินสด — เมื่อบันทึกซื้อแต่เงินสดในพอร์ตไม่พอ</label>
              <select name="cashFlowPolicy" className="input" defaultValue={settings.cashFlowPolicy}>
                <option value="strict">เข้มงวด: ปฏิเสธรายการ ให้บันทึกฝากเงินก่อน (แนะนำ)</option>
                <option value="infer_with_warning">ยอมรับ: อนุมานเป็นเงินฝากจากภายนอก พร้อมคำเตือน</option>
              </select>
            </div>
            <div>
              <label className="label">จังหวะเงินเข้า/ออกในการคำนวณ TWR</label>
              <select name="twrFlowTiming" className="input" defaultValue={settings.twrFlowTiming}>
                <option value="start_of_day">ต้นวัน: rₜ = Vₜ / (Vₜ₋₁ + CFₜ) − 1</option>
                <option value="end_of_day">สิ้นวัน: rₜ = (Vₜ − CFₜ) / Vₜ₋₁ − 1</option>
                <option value="modified_dietz">Modified Dietz (กลางวัน)</option>
              </select>
            </div>
          </ActionForm>
        </Section>

        <Section title="แบบจำลองและคุณภาพข้อมูล">
          <div className="space-y-2 text-sm">
            <p>
              สูตรเวอร์ชัน <b>{MODEL_VERSION}</b> — valuation ที่บันทึกจะเก็บเวอร์ชันนี้ไว้ ถ้าสูตรเปลี่ยน ระบบจะบอกว่าค่าไหนคำนวณด้วยสูตรเก่า
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
              <li>ผลตอบแทน: TWR ({settings.twrFlowTiming}), XIRR ACT/365, ต่ำกว่า 1 ปีแสดงแบบสะสม · Sharpe จากผลตอบแทนส่วนเกินรายงวด × √N</li>
              <li>DCF: terminal แบบ Gordon / stable ROIC / exit multiple, mid-year ทั้งงวดและ terminal · ไม่แสดงมูลค่าถ้า r ≤ g</li>
              <li>จัดพอร์ต: QP แบบ exact, ไม่ผ่อนข้อจำกัดเอง · พันธบัตร: day count / stub / call ตามเงื่อนไขตราสาร</li>
            </ul>
            <Link href="/data-quality" className="btn-ghost inline-block text-xs">
              ดูรายงานคุณภาพข้อมูล →
            </Link>
          </div>
        </Section>

        <Section title="ต้นทุนการซื้อขาย (ใช้กับข้อเสนอ rebalance)">
          <ActionForm action={saveTradingCostsAction} className="space-y-3" resetOnSuccess={false}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {(
                [
                  ["commissionPct", "ค่าคอมมิชชัน (% ของมูลค่า)", costs.commissionPct, "0.001"],
                  ["minCommission", "ค่าคอมขั้นต่ำ/รายการ (บาท)", costs.minCommission, "1"],
                  ["vatPct", "VAT บนค่าคอม (%)", costs.vatPct, "0.1"],
                  ["slippageBps", "Slippage / spread (bps)", costs.slippageBps, "1"],
                  ["sellTaxPct", "ภาษีขาย (% ของมูลค่าขาย)", costs.sellTaxPct, "0.01"],
                  ["minTradeValue", "มูลค่าซื้อขายขั้นต่ำ (บาท)", costs.minTradeValue, "100"],
                ] as const
              ).map(([name, label, v, step]) => (
                <div key={name}>
                  <label className="label">{label}</label>
                  <input name={name} type="number" step={step} min={0} className="input" defaultValue={v} />
                </div>
              ))}
            </div>
            <div>
              <div className="label">ขนาด lot (หน่วยต่อ lot) — ว่าง = 1 · หุ้นไทยกระดานหลัก 100 หุ้น</div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {(["thai_stock", "us_stock", "fund", "bond", "gold"] as const).map((c) => (
                  <div key={c}>
                    <label className="text-[11px] text-muted">{ASSET_CLASS_LABEL[c]}</label>
                    <input name={`lot_${c}`} type="number" step="any" min={0} className="input" defaultValue={costs.lotSize[c] ?? ""} />
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted">ค่าเริ่มต้นเป็น 0 — ใส่ตามโบรกเกอร์ของคุณ · ใช้คำนวณข้อเสนอเท่านั้น ไม่บันทึกรายการซื้อขายให้</p>
          </ActionForm>
        </Section>

        <Section title="เกณฑ์วันที่ข้อมูลของ valuation">
          <ActionForm action={saveTimestampPolicyAction} className="space-y-3" resetOnSuccess={false}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  ["inputsMaxAgeDays", "Rf / ERP / Beta เก่าได้ไม่เกิน (วัน)", tsPolicy.inputsMaxAgeDays, 1],
                  ["priceMaxGapDays", "ราคาห่างจากวันประเมินได้ไม่เกิน (วัน)", tsPolicy.priceMaxGapDays, 0],
                  ["statementsMaxAgeDays", "งบปีล่าสุดเก่าได้ไม่เกิน (วัน)", tsPolicy.statementsMaxAgeDays, 30],
                ] as const
              ).map(([name, label, v, min]) => (
                <div key={name} className="flex flex-col justify-end">
                  <label className="label" htmlFor={`ts-${name}`}>
                    {label}
                  </label>
                  <input id={`ts-${name}`} name={name} type="number" step={1} min={min} className="input" defaultValue={v} />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">
              ใช้แสดงป้าย “วันที่ข้อมูลไม่ตรง” ในหน้า valuation, หน้าแก้ไข และหน้าคุณภาพข้อมูล — เป็นแค่การเตือน ไม่เปลี่ยนตัวเลข · ค่าเริ่มต้น 180 / 7 / 548 วัน
              เป็นจุดตั้งต้น ไม่ใช่มาตรฐาน · งบใช้ปีบัญชีล่าสุดที่จบก่อนวันประเมิน (ถือว่าสิ้นปี 31 ธ.ค.)
            </p>
          </ActionForm>
        </Section>

        <Section title="Yield curve พันธบัตรรัฐบาล (สำหรับ credit spread)">
          <YieldCurveForm initial={curve} today={today()} />
        </Section>

        <Section title="เป้าหมาย Asset allocation (%)">
          <ActionForm action={saveTargetsAction} className="space-y-3" resetOnSuccess={false}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {ASSET_CLASSES.map((c) => (
                <div key={c}>
                  <label className="label">{ASSET_CLASS_LABEL[c]}</label>
                  <input name={c} type="number" step="0.5" min={0} max={100} className="input" defaultValue={targets[c] ?? 0} />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">รวมกันต้องเท่ากับ 100%</p>
          </ActionForm>
        </Section>
      </div>

      <Section title="เชื่อมต่อ Claude (MCP)">
        <div className="space-y-3 text-sm">
          <p>
            claude.ai → Settings → Connectors → <b>Add custom connector</b> แล้วใส่ URL ด้านล่าง (แทน <code>YOUR_API_KEY</code> ด้วยค่า <code>API_KEY</code> ใน env)
          </p>
          <CopyBlock label="Connector URL" text={`${origin}/api/mcp?key=YOUR_API_KEY`} />
          <CopyBlock label="Claude Code" text={`claude mcp add --transport http investment-diary ${origin}/api/mcp --header "Authorization: Bearer YOUR_API_KEY"`} />
          <p className="text-xs text-muted">
            เครื่องมือ: add_note, search_notes, record_transaction, list_transactions, add_asset, list_assets, update_price, get_portfolio_summary,
            get_allocation, get_performance_metrics, get_portfolio_optimization, value_security, save_valuation, list_valuations, analyze_bond,
            get_bond_holdings, get_investment_universe, optimize_portfolio, rebalance_portfolio, stress_test_portfolio, backtest_portfolio, sync_historical_prices, import_prices
          </p>
        </div>
      </Section>

      <Section title="เชื่อมต่อ ChatGPT (Custom GPT Actions)">
        <div className="space-y-3 text-sm">
          <ol className="list-decimal space-y-1 pl-5">
            <li>ChatGPT → Explore GPTs → Create → Configure</li>
            <li>Actions → Create new action → Import from URL: วาง OpenAPI URL ด้านล่าง</li>
            <li>Authentication → API Key → Auth type <b>Bearer</b> → ใส่ค่า <code>API_KEY</code></li>
            <li>วาง Instructions ด้านล่างในช่อง Instructions แล้วบันทึก GPT (ตั้งเป็น Only me)</li>
          </ol>
          <CopyBlock label="OpenAPI schema URL" text={`${origin}/api/openapi.json`} />
          <CopyBlock label="Instructions" text={GPT_INSTRUCTIONS} />
        </div>
      </Section>
    </>
  );
}
