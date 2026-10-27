# Investment Diary 📒

เว็บแอปบันทึกการลงทุนส่วนตัว — จดแนวคิดเป็น timeline, ติดตามพอร์ต **หุ้นไทย / หุ้นต่างประเทศ / พันธบัตร / กองทุน / ทองคำ**,
คำนวณ **asset allocation** และวัดผลตาม **ทฤษฎีการเงิน** และให้ **Claude หรือ ChatGPT บันทึกข้อมูลให้ได้**

## ความสามารถ
- **Journal timeline** — ไอเดีย, thesis, ทบทวน, บทเรียน, มุมมองตลาด (Markdown) พร้อมแท็ก, ระดับความมั่นใจ, ผูกกับสินทรัพย์และรายการซื้อขาย
- **พอร์ต** — ต้นทุนเฉลี่ย, กำไรที่รับรู้/ยังไม่รับรู้, ปันผล/ดอกเบี้ย, สกุลเงินหลักบาท รองรับ USD (แปลงด้วยอัตราแลกเปลี่ยนรายวัน)
- **Asset allocation** — สัดส่วนจริง vs เป้า, drift และยอดที่ต้องซื้อ/ขายเพื่อ rebalance
- **Performance ตามทฤษฎี**
  - Time-weighted return (ตัดผลการฝาก/ถอน) และ Money-weighted return (XIRR)
  - Risk-free rate (ตั้งค่าได้), risk premium, volatility, downside deviation, max drawdown, VaR/CVaR
  - Sharpe, Sortino, Calmar, **CAPM**: beta, expected return, Jensen's alpha, Treynor, tracking error, information ratio เทียบ SET Index
  - **Modern Portfolio Theory**: covariance/correlation, efficient frontier (long-only), min-variance, max-Sharpe (tangency), Capital Market Line
- **ประเมินมูลค่าหุ้น (แก้สมมติฐานได้ทุกตัว)**
  - DCF แบบ **FCFF** (คิดลดด้วย WACC) และ **FCFE** (คิดลดด้วย Ke) จากประมาณการรายได้ margin capex D&A NWC
  - **DCF หลายช่วง (2–4 ช่วง เช่น high growth / transition / mature)** หรือ fade เส้นเดียวแบบเดิม — ดู [คู่มือ](docs/roadmap/MULTISTAGE_RIM_GUIDE.md)
  - Ke จาก CAPM (Rf + β·ERP + premium), WACC แบบ market value หรือโครงสร้างทุนเป้าหมาย, terminal แบบ Gordon หรือ exit multiple, mid-year convention
  - ตารางกระแสเงินสด, sensitivity (WACC × g), reverse DCF (growth ที่ราคาตลาดสะท้อน), implied exit multiple, คำเตือนเมื่อ TV สูงหรือ r ≤ g
  - **DDM** (Gordon / two-stage / H-model), **Residual income** + justified P/BV, P/E (หลายปี: เทียบ 5 ปี vs 10 ปีบนข้อมูลชุดเดียว, waterfall, ROE vs Ke, sensitivity ω / Ke × ROE / Ke × g), **Relative multiples** (P/E, P/BV, EV/EBITDA)
  - เทียบผลทุกวิธีแบบ football field, บันทึกหลาย scenario, ดึงข้อมูลพื้นฐานจาก Yahoo ได้
  - **อัปโหลดงบการเงิน (PDF / Excel .xlsx / CSV)** แยกไฟล์ได้หลายไฟล์ — AI (Claude) อ่านและกรอกงบย้อนหลัง 5 ปีให้
    (รายได้, EBIT, ค่าเสื่อม, capex, หนี้, เงินสด, จำนวนหุ้น, EPS, DPS ฯลฯ แปลงเป็นหน่วยล้าน), ตารางแก้ไขได้, อัตราส่วนย้อนหลัง,
    และปุ่ม “เติมสมมติฐานจากงบการเงิน” (CAGR, margin เฉลี่ย, capex %, NWC %, ภาษี, ต้นทุนหนี้) — ไฟล์ไม่ถูกเก็บ, จำกัด 4.5MB ต่อไฟล์
- **พันธบัตร / หุ้นกู้** — ราคา ↔ YTM, accrued interest, clean/dirty, current yield, Macaulay/modified duration, convexity, DV01, yield to call,
  price–yield curve, ตั๋วเงินคลังแบบส่วนลด และ YTM/duration ของพันธบัตรในพอร์ต
- **แนะนำน้ำหนักการลงทุน (Modern Portfolio Theory)** — minimum-variance frontier รูป “หัวกระสุน” ทั้งกรณีขายชอร์ตได้ (สูตรปิด) และกรณีมีข้อจำกัด
  (long-only, น้ำหนักต่ำสุด/สูงสุดต่อตัว), max Sharpe, min variance, utility ตาม risk aversion, target return/risk,
  complete portfolio บน Capital Market Line (y* = (E[R]−Rf)/(Aσ²)), แก้ผลตอบแทนคาดหวังรายตัว (อดีต / CAPM / ผสม),
  รายการซื้อขายเป็นบาท และบันทึกเป็นเป้าหมาย asset allocation ได้ในคลิกเดียว
- **AI ที่ปรึกษาในแอป** (Claude) — อ่านพอร์ตจริงและใช้เครื่องมือคำนวณของแอป (DCF, DDM, bond, optimizer) ก่อนให้คำแนะนำ เก็บประวัติบทสนทนา
- **ราคาอัตโนมัติ (ฟรี)** — Yahoo Finance: หุ้นไทย (`PTT.BK`), SET (`^SET.BK`), หุ้น US, ทองคำ (`GC=F` → ทองแท่งไทย 96.5% `GOLD_TH`), USD/THB;
  NAV กองทุนไทยจาก SEC Open API (ถ้ามีคีย์); พันธบัตร/อื่น ๆ กรอกเองหรือให้ AI อัปเดต · Vercel Cron ดึงราคาทุกวันทำการ 18:30 น.
- **AI integration** — MCP server สำหรับ Claude และ OpenAPI สำหรับ ChatGPT Custom GPT → ดู [docs/AI_SETUP.md](docs/AI_SETUP.md)

## Tech stack
Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · Recharts · Postgres + Drizzle ORM · zod · MCP TypeScript SDK · Vitest

```
src/
  lib/finance/      สูตรการเงิน (pure functions + tests): returns, risk, ratios, mpt, optimizer, recommend,
                    valuation (DCF/DDM/RI/multiples), bonds, portfolio, allocation, metrics
  lib/prices/       Yahoo Finance, SEC Thailand, ราคาทองไทย
  server/services/  business logic ที่ UI, REST API และ MCP ใช้ร่วมกัน
  server/mcp.ts     MCP tools · server/openapi.ts  OpenAPI spec · server/advisor.ts  AI ที่ปรึกษา (Claude tool runner)
  app/(app)/        หน้าเว็บ · app/api/v1  REST · app/api/mcp  MCP endpoint · app/api/cron/prices
```

## รันบนเครื่อง
```bash
npm install
cp .env.example .env          # แก้ DATABASE_URL, APP_PASSWORD, SESSION_SECRET, API_KEY
npm run db:migrate
npm run db:seed               # (ไม่บังคับ) ข้อมูลตัวอย่างพร้อมราคาจำลอง — ใช้ --reset เพื่อล้างข้อมูลเดิม
npm run dev                   # http://localhost:3000
```
คำสั่งอื่น: `npm test` · `npm run typecheck` · `npm run lint` · `npm run prices:update` · `npm run db:generate` (หลังแก้ schema)

## Deploy บน Vercel + Neon (ฟรี)
1. Push repo นี้ขึ้น GitHub แล้ว **Import** ใน Vercel
2. Vercel → Storage → **Create Database → Neon (Postgres)** แล้วเชื่อมกับโปรเจกต์ (จะได้ `DATABASE_URL` อัตโนมัติ)
3. ตั้ง Environment Variables:

   | ตัวแปร | ค่า |
   |---|---|
   | `DATABASE_URL` | จาก Neon (ใช้ pooled connection ได้) |
   | `APP_PASSWORD` | รหัสผ่านเข้าเว็บ |
   | `SESSION_SECRET` | สตริงสุ่มยาว ≥ 32 ตัว (`openssl rand -hex 32`) |
   | `API_KEY` | คีย์สำหรับ Claude / ChatGPT (`openssl rand -hex 32`) |
   | `CRON_SECRET` | สตริงสุ่ม — Vercel Cron ส่งเป็น Bearer ให้ `/api/cron/prices` |
   | `SEC_API_KEY` | (ไม่บังคับ) subscription key จาก https://api-portal.sec.or.th สำหรับ NAV กองทุน |
   | `ANTHROPIC_API_KEY` | (สำหรับ AI ที่ปรึกษา และการอ่านงบการเงินจากไฟล์) สร้างที่ https://console.anthropic.com — คิดค่าใช้จ่ายตามการใช้งาน |
   | `ADVISOR_EFFORT` | (ไม่บังคับ) `low` / `medium` (ค่าเริ่มต้น) / `high` — คุณภาพการวิเคราะห์ vs ค่าใช้จ่าย |
   | `EXPLAIN_EFFORT` | (ไม่บังคับ) ระดับการคิดของปุ่ม "อธิบาย" — ค่าเริ่มต้น `low` (เร็วและประหยัด) · `EXPLAIN_MODEL` เปลี่ยนโมเดลได้ (ค่าเริ่มต้นตาม `ADVISOR_MODEL`) |

4. Migration รันอัตโนมัติทุกครั้งที่ Vercel build (`vercel-build` = `db:migrate` แล้ว `next build`) — ถ้าต้องการรันเอง: `DATABASE_URL=<neon url> npm run db:migrate`
5. Deploy → เข้าเว็บ → ตั้ง risk-free rate และเป้า allocation ในหน้า **ตั้งค่า** → เพิ่มสินทรัพย์ → กด **ดึงราคาล่าสุด**

## วิธีคิดที่ควรรู้
- รายการ `buy/sell` ใช้ `quantity × price` (สกุลเงินของสินทรัพย์); `dividend/coupon/deposit/withdraw/fee` ใส่จำนวนเงินรวมใน `price`
- ค่าเริ่มต้น (strict): ต้องบันทึก "ฝากเงิน" ก่อนซื้อ รายการที่เงินสดไม่พอหรือขายเกินจำนวนที่ถือจะถูกปฏิเสธ — รายการเก่าที่ไม่มีเงินฝากจะถูกแสดงเป็น "เงินฝากที่ระบบอนุมาน" พร้อมคำเตือน (เปลี่ยนเป็นโหมดอนุมานได้ในหน้าตั้งค่า)
- เงินสดในพอร์ตเก็บเป็นบาท; ต้นทุนสินทรัพย์ USD ใช้อัตราแลกเปลี่ยน ณ วันซื้อ, มูลค่าปัจจุบันใช้อัตราล่าสุด (รวมผลค่าเงิน)
- ผลตอบแทนช่วงสั้นกว่า 1 ปีจะไม่ถูกแปลงเป็นรายปี (ไม่ extrapolate)
- MPT ใช้ข้อมูลในอดีตซึ่งมี estimation error สูง ใช้ประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุน — แนะนำให้ใช้ผลตอบแทนแบบผสม (อดีต + CAPM) และจำกัดน้ำหนักต่อตัว
- DCF: ทุกช่องตัวเงินต้องใช้หน่วยเดียวกัน (เช่น ล้านบาท และล้านหุ้น); ราคาพันธบัตรในแอปเก็บต่อหน่วย ระบบแปลงเป็นต่อ 100 ของ face value ให้อัตโนมัติ
- คำนวณพันธบัตรใช้ Actual/Actual (ICMA) และ street convention ซึ่งอาจต่างจากราคาประกาศ ThaiBMA เล็กน้อยในบางกรณี
- อัปโหลดงบ: Vercel รับไฟล์ได้ไม่เกิน ~4.5MB ต่อครั้ง — รายงานประจำปี/56-1 ฉบับเต็มให้ตัดเฉพาะหน้างบการเงิน (เช่นด้วย “Print → Save as PDF” เลือกหน้า);
  .xls ให้บันทึกเป็น .xlsx; ตัวเลขที่ AI อ่านต้องตรวจทานก่อนใช้ (PDF ที่เป็นภาพสแกนอ่านได้แต่แม่นยำน้อยกว่า)
- AI ที่ปรึกษาบน Vercel: คำถามที่ต้องคำนวณหลายขั้นอาจใช้เวลา 30–90 วินาที (route ตั้ง maxDuration 300 วินาที — แผน Hobby อาจถูกจำกัดต่ำกว่า)

## ข้อจำกัด
- Yahoo Finance เป็น API ไม่เป็นทางการ อาจเปลี่ยนหรือจำกัดการใช้งาน — กรอกราคาเองได้เสมอ
- ราคาทองแท่งสมาคมค้าทองคำไม่มี API ฟรี จึงประมาณจาก spot × USDTHB (อาจต่างจากราคาประกาศเล็กน้อย)
- SEC Open API ต้องสมัครคีย์ฟรี; ถ้าไม่มีให้ใช้ priceSource `manual`
