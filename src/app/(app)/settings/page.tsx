import { headers } from "next/headers";
import { getSettings, getTargets } from "@/server/services/settings";
import { ActionForm } from "@/components/ActionForm";
import { CopyBlock } from "@/components/CopyBlock";
import { PageHeader, Section } from "@/components/ui";
import { saveSettingsAction, saveTargetsAction } from "../actions";
import { ASSET_CLASSES } from "@/lib/finance/allocation";
import { ASSET_CLASS_LABEL } from "@/lib/format";
import { GPT_INSTRUCTIONS } from "@/lib/gpt-instructions";

export default async function SettingsPage() {
  const [settings, targets, h] = await Promise.all([getSettings(), getTargets(), headers()]);
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;

  return (
    <>
      <PageHeader title="ตั้งค่า" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="สมมติฐานทางการเงิน">
          <ActionForm action={saveSettingsAction} className="space-y-3" resetOnSuccess={false}>
            <div>
              <label className="label">Risk-free rate (% ต่อปี) — เช่น อัตราผลตอบแทนพันธบัตรรัฐบาลไทย 1 ปี (ThaiBMA / ธปท.)</label>
              <input name="riskFreeRate" type="number" step="0.01" className="input" defaultValue={settings.riskFreeRate} />
            </div>
            <div>
              <label className="label">Equity risk premium (% ต่อปี) — ใช้คำนวณ Ke ด้วย CAPM และผลตอบแทนคาดหวังใน optimizer</label>
              <input name="equityRiskPremium" type="number" step="0.1" className="input" defaultValue={settings.equityRiskPremium} />
            </div>
            <div>
              <label className="label">ดัชนีอ้างอิง (สัญลักษณ์ Yahoo) — ^SET.BK = SET Index, ^SET50.BK, ^GSPC = S&amp;P 500</label>
              <input name="benchmarkSymbol" className="input" defaultValue={settings.benchmarkSymbol} />
            </div>
          </ActionForm>
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
            get_bond_holdings, get_investment_universe, optimize_portfolio
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
