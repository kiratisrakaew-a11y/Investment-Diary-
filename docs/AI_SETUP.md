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

บันทึกที่มาจาก Claude จะติดป้าย **via Claude** ใน timeline

## 2. ChatGPT (Custom GPT)
ต้องใช้บัญชี ChatGPT ที่สร้าง GPT ได้ (Plus / Team / Enterprise)

1. ChatGPT → **Explore GPTs → Create → Configure**
2. **Actions → Create new action → Import from URL** → `https://<your-app>.vercel.app/api/openapi.json`
3. **Authentication → API Key → Bearer** → ใส่ค่า `API_KEY`
4. วาง **Instructions** (คัดลอกจากหน้าตั้งค่า หรือ `src/lib/gpt-instructions.ts`)
5. ตั้ง visibility เป็น **Only me** แล้ว Save

Actions: `addNote`, `searchNotes`, `recordTransaction`, `listTransactions`, `addAsset`, `listAssets`,
`updatePrice`, `getPortfolioSummary`, `getAllocation`, `getPerformanceMetrics`, `getPortfolioOptimization`

## 3. REST ด้วย curl (ทดสอบ / ใช้กับเครื่องมืออื่น)
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
