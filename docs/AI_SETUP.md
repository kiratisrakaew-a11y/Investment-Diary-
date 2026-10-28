# เชื่อมต่อ Claude และ ChatGPT ให้บันทึกลง Investment Diary

แอปเปิดให้ AI เขียน/อ่านข้อมูลได้ 2 ทาง โดยใช้คีย์เดียวกันคือค่า `API_KEY` ใน environment variables

| ช่องทาง | ใช้กับ | URL |
|---|---|---|
| MCP (Streamable HTTP) | claude.ai, Claude Desktop, Claude Code | `https://<your-app>.vercel.app/api/mcp` |
| REST + OpenAPI 3.1 | ChatGPT Custom GPT (Actions) | `https://<your-app>.vercel.app/api/openapi.json` |

> หน้า **ตั้งค่า** ในแอปแสดง URL จริงของคุณพร้อมปุ่มคัดลอก

## 1. Claude

### claude.ai / Claude Desktop (Custom connector)
1. Settings → Connectors → **Add custom connector**
2. Name: `Investment Diary`
3. URL: `https://<your-app>.vercel.app/api/mcp?key=<API_KEY>`
   (connector ของ claude.ai ใส่ header เองไม่ได้ จึงส่งคีย์ผ่าน query string — อย่าแชร์ URL นี้)
4. เปิดใช้ connector ในแชต แล้วพูดได้เลย เช่น
   - "บันทึกไอเดีย: PTT ราคาต่ำกว่า book ปันผล 6% ความเสี่ยงคือการคุมราคาน้ำมัน conviction 3"
   - "วันนี้ซื้อ PTT 1,000 หุ้น ที่ 33.25 ค่าคอม 50 บาท ผูกกับบันทึกเมื่อกี้"
   - "พอร์ตตอนนี้ Sharpe เท่าไร เทียบ SET แล้วมี alpha ไหม"
   - "ถ้าจะ rebalance ตามเป้าต้องซื้อขายอะไรบ้าง"

### Claude Code
```bash
claude mcp add --transport http investment-diary https://<your-app>.vercel.app/api/mcp \
  --header "Authorization: Bearer <API_KEY>"
```

### เครื่องมือ (MCP tools)
| Tool | หน้าที่ |
|---|---|
| `add_note` | เขียนบันทึก (idea / thesis / review / lesson / market) ลง timeline |
| `search_notes` | ค้นบันทึกตามข้อความ ประเภท แท็ก สินทรัพย์ ช่วงวันที่ |
| `record_transaction` | ซื้อ / ขาย / ปันผล / ดอกเบี้ย / ฝาก / ถอน / ค่าธรรมเนียม |
| `list_transactions` | รายการล่าสุด |
| `add_asset`, `list_assets` | ลงทะเบียนสินทรัพย์ใหม่ / ดูรายการ |
| `update_price` | ใส่ราคาปิด / NAV เอง (พันธบัตร กองทุน ฯลฯ) |
| `get_portfolio_summary` | สินทรัพย์ที่ถือ ต้นทุน มูลค่า กำไร/ขาดทุน |
| `get_allocation` | สัดส่วนจริง vs เป้า และยอดที่ต้องปรับ |
| `get_performance_metrics` | TWR, XIRR, σ, MDD, VaR, Sharpe, Sortino, Beta, Jensen's α, Treynor |
| `get_portfolio_optimization` | Markowitz: min-variance, max-Sharpe, correlation, CML |
| `value_security` | ประเมินมูลค่า: `dcf_fcff`, `dcf_fcfe`, `ddm`, `residual_income`, `multiples`, `bond` พร้อม sensitivity |
| `save_valuation`, `list_valuations` | บันทึก / ดู valuation ในแอป |
| `analyze_bond`, `get_bond_holdings` | ราคา ↔ YTM, duration, convexity / พันธบัตรในพอร์ต |
| `get_investment_universe` | ผลตอบแทนอดีต, σ, β, ผลตอบแทนตาม CAPM ของแต่ละสินทรัพย์ |
| `get_financial_statements`, `save_financial_statements` | งบการเงินย้อนหลัง + อัตราส่วน / บันทึกงบที่อ่านจากไฟล์ที่คุณแนบในแชต |
| `optimize_portfolio` | แนะนำน้ำหนักตาม MPT (max Sharpe, min variance, utility, target return/risk) พร้อมรายการซื้อขาย |

บันทึกที่มาจาก Claude จะติดป้าย **via Claude** ใน timeline

### Custom Metrics ผ่าน MCP
ใช้ติดตามตัวชี้วัดของสินทรัพย์รายตัวที่คุณกำหนดเอง เช่น NPL Ratio ของ BBL พร้อมไฟเขียว/เหลือง/แดง ใช้ service, กฎ และ audit ชุดเดียวกับหน้าสินทรัพย์และ REST (รายละเอียด: [ASSET_CUSTOM_METRICS.md](ASSET_CUSTOM_METRICS.md))

| Tool | หน้าที่ | อ่านอย่างเดียว |
|---|---|---|
| `list_asset_metrics` | รายการตัวชี้วัด ค่าล่าสุด สถานะ ความสดของข้อมูล และเวอร์ชันเกณฑ์ (ค่าเริ่มต้นไม่รวมประวัติ) | ✓ |
| `create_asset_metric` | สร้างตัวชี้วัด (ชื่อ หน่วย ความถี่ …) ได้ `metricId` กลับมา | |
| `update_asset_metric` | แก้ข้อมูล / `isActive:false` เก็บถาวร / `true` คืนค่า · เปลี่ยนหน่วยเมื่อมีค่าแล้วต้อง `confirmUnitChange:true` (ไม่แปลงค่าเดิม) | |
| `delete_asset_metric` | ลบถาวรพร้อมค่าและเกณฑ์ ต้องส่ง `confirmName` = ชื่อตรงทุกตัว | |
| `record_metric_observation` | บันทึกค่า 1 วันที่ (`observedOn`, `value`, `source`, `publishedOn`) · วันที่ซ้ำ → `DUPLICATE_OBSERVATION` (ไม่เขียนทับ) | |
| `update_metric_observation` | แก้ค่าเดิม (id เดิม) | |
| `delete_metric_observation` | ลบค่า 1 รายการ ต้องส่ง `confirmDelete:true` | |
| `get_metric_history` | ประวัติแบ่งหน้า (`limit` ≤ 1000, `offset`, `from`/`to`) พร้อมสถานะตามเกณฑ์ของวันนั้น | ✓ |
| `list_metric_thresholds` | เวอร์ชันเกณฑ์ทั้งหมด | ✓ |
| `preview_metric_threshold` | ดูผลของเกณฑ์ใหม่ก่อนบันทึก — **ไม่เขียนอะไร** | ✓ |
| `set_metric_threshold` | บันทึกเกณฑ์เวอร์ชันใหม่ (ต้องเริ่มหลังเวอร์ชันล่าสุด ไม่ย้อนแก้อดีต) | |
| `get_metric_series` | ข้อมูลกราฟ `actual` / `indexed` / `change` (ไม่เติมช่องว่าง) | |

- **ต่างจาก `get_performance_metrics`**: ตัวนั้นคือผลตอบแทน/ความเสี่ยงของพอร์ต (TWR, Sharpe …) ส่วน `list_asset_metrics` คือตัวชี้วัดของหลักทรัพย์รายตัวที่ผู้ใช้กำหนดเอง
- ระบุสินทรัพย์ด้วย `symbol` (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ต้องมีสินทรัพย์อยู่แล้ว — ไม่พบ → `ASSET_NOT_FOUND` ระบบไม่สร้างสินทรัพย์ให้เอง · ระบุตัวชี้วัดด้วย `metricId` เสมอ (ไม่เดาจากชื่อ)
- เกณฑ์ใช้หน่วยดิบของตัวชี้วัด: lower-is-better → green ≤ `greenBound` < yellow ≤ `yellowBound` < red · higher-is-better → red < `yellowBound` ≤ yellow < `greenBound` ≤ green · target range → `yellowMin` < `greenMin` ≤ green ≤ `greenMax` < `yellowMax` (นอกช่วงเหลือง = แดง) · เวอร์ชันมีผลช่วง `effectiveFrom ≤ วันที่ < effectiveTo`
- **เกณฑ์เป็นของผู้ใช้เอง** ไม่ใช่เกณฑ์ตลาดหลักทรัพย์ มาตรฐานอุตสาหกรรม หรือเกณฑ์ ธปท. เว้นแต่ระบุแหล่งที่ตรวจสอบได้
- **AI ห้ามแต่งค่าหรือเกณฑ์ขึ้นเอง** — บันทึกเฉพาะค่าที่ผู้ใช้ให้มา หรือจากรายงานที่อ้างอิงได้ พร้อมใส่ `source` และ `publishedOn` เมื่อทราบ
- ข้อผิดพลาดมีรหัสในวงเล็บ เช่น `Error: … [DUPLICATE_OBSERVATION]` และส่ง `{ "code": … }` แยกอีกบรรทัด: `ASSET_NOT_FOUND`, `METRIC_NOT_FOUND`, `OBSERVATION_NOT_FOUND`, `DUPLICATE_METRIC`, `DUPLICATE_OBSERVATION`, `THRESHOLD_OVERLAP`, `THRESHOLD_IN_EFFECT`, `UNIT_CHANGE_NEEDS_CONFIRMATION`, `CONFIRMATION_REQUIRED`, `VALIDATION_ERROR`
- ทุกการเขียนผ่าน MCP บันทึก `sourceKind = "mcp"` ในค่า และ `source = "mcp"` ใน audit

**ตรวจว่า deploy แล้วจริง:** การมีโค้ดใน repo ยังไม่ได้แปลว่า connector ที่ใช้อยู่เห็น tools ใหม่ — หลัง deploy ให้สั่ง AI เรียก `get_server_info` แล้วดูว่า `version` ตรงกับ commit ล่าสุดและ `tools` มีทั้ง 12 ชื่อข้างบน (ถ้าไม่มี ให้ refresh / เชื่อม connector ใหม่) เชื่อมต่อด้วย endpoint และ API key เดิม — อย่าแปะ key ในแชตหรือภาพหน้าจอ

ตัวอย่างคำสั่ง (หลัง deploy แล้ว):
> เพิ่ม Metric `NPL Ratio` ให้หุ้น `BBL` หน่วย `%` รายไตรมาส ถ้ายังไม่มีให้สร้างก่อน แล้วตั้ง Lower-is-better ให้ Green ≤ 2.5%, Yellow > 2.5% ถึง 3.5%, Red > 3.5% เริ่มใช้ตามวันที่ที่ฉันกำหนด โดยแสดง Preview ก่อนบันทึก เมื่อฉันให้ค่า NPL พร้อมวันที่และแหล่งอ้างอิง ให้บันทึกลง Metric นี้ แล้วอ่านสถานะที่ระบบประเมินกลับมา

ลำดับที่ AI ควรทำ: `list_asset_metrics` (ดูว่ามีแล้วหรือยัง) → `create_asset_metric` ถ้ายังไม่มี → `preview_metric_threshold` แสดงผลให้ยืนยัน → `set_metric_threshold` → `record_metric_observation` ด้วยค่าที่คุณให้ → `get_metric_history` / `list_asset_metrics` อ่านสถานะ

## 2. ChatGPT (Custom GPT)
ต้องใช้บัญชี ChatGPT ที่สร้าง GPT ได้ (Plus / Team / Enterprise)

1. ChatGPT → **Explore GPTs → Create → Configure**
2. **Actions → Create new action → Import from URL** → `https://<your-app>.vercel.app/api/openapi.json`
3. **Authentication → API Key → Bearer** → ใส่ค่า `API_KEY`
4. วาง **Instructions** (คัดลอกจากหน้าตั้งค่า หรือ `src/lib/gpt-instructions.ts`)
5. ตั้ง visibility เป็น **Only me** แล้ว Save

Actions: `addNote`, `searchNotes`, `recordTransaction`, `listTransactions`, `addAsset`, `listAssets`,
`updatePrice`, `getPortfolioSummary`, `getAllocation`, `getPerformanceMetrics`, `getPortfolioOptimization`,
`valueSecurity`, `saveValuation`, `listValuations`, `analyzeBond`, `getBondHoldings`, `optimizePortfolio`,
`getFinancialStatements`, `saveFinancialStatements` (แนบไฟล์งบใน ChatGPT แล้วสั่ง “อ่านงบนี้แล้วบันทึกลงแอป”)

## 3. AI ที่ปรึกษาในแอป (หน้า “AI ที่ปรึกษา”)
ใช้ Claude ผ่าน Claude API โดยตรง ไม่ต้องตั้ง connector — ใส่ `ANTHROPIC_API_KEY` ใน environment variables แล้วใช้งานได้ทันที
ที่ปรึกษาจะเรียกเครื่องมือของแอปเอง (พอร์ต, ผลการดำเนินงาน, optimizer, DCF/DDM, bond, ข้อมูลพื้นฐานจาก Yahoo) ก่อนตอบ
และบันทึกโน้ต / valuation ให้เมื่อคุณสั่ง ตัวอย่างคำถาม:
- "แนะนำน้ำหนักการลงทุนตาม MPT ถ้าฉันรับความเสี่ยงได้ปานกลาง จำกัดไม่เกิน 35% ต่อตัว"
- "ประเมินมูลค่า PTT ด้วย DCF แบบ FCFF และ DDM แล้วเทียบกัน พร้อม sensitivity"
- "ถ้าดอกเบี้ยขึ้น 0.5% พันธบัตรในพอร์ตจะขาดทุนประมาณเท่าไร"

### อัปโหลดงบการเงินให้ AI กรอก
หน้า “ประเมินมูลค่า” → ส่วน “งบการเงินย้อนหลัง” → ลากไฟล์ PDF / .xlsx / .csv มาวาง (หลายไฟล์ได้ เช่นไฟล์ละปี)
AI จะอ่านงบการเงินรวม แปลงปี พ.ศ. → ค.ศ. และหน่วย (บาท/พันบาท/ล้านบาท) เป็นล้าน แล้วรวมเป็นตาราง 5 ปี ปีที่ซ้ำกันใช้ไฟล์ล่าสุด
ตรวจ/แก้ตัวเลขในตาราง แล้วกด “เติมสมมติฐานจากงบการเงิน” — AI ที่ปรึกษาก็ใช้งบชุดนี้ได้ผ่านเครื่องมือ `get_financial_statements`

## 4. REST ด้วย curl (ทดสอบ / ใช้กับเครื่องมืออื่น)
```bash
API=https://<your-app>.vercel.app
KEY=<API_KEY>

curl -X POST $API/api/v1/assets -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"symbol":"PTT","name":"PTT","assetClass":"thai_stock","priceSource":"yahoo","providerSymbol":"PTT.BK"}'

curl -X POST $API/api/v1/transactions -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"type":"buy","symbol":"PTT","quantity":1000,"price":33.25,"fee":50}'

curl $API/api/v1/portfolio/performance -H "Authorization: Bearer $KEY"
```

## ความปลอดภัย
- ตั้ง `API_KEY` ให้ยาวและสุ่ม (เช่น `openssl rand -hex 32`) และเปลี่ยนได้ทุกเมื่อใน Vercel → Environment Variables
- คีย์นี้เขียนข้อมูลได้ทั้งหมด อย่าใส่ใน GPT ที่แชร์ให้คนอื่น
