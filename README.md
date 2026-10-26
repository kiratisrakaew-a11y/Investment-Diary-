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
- **ราคาอัตโนมัติ (ฟรี)** — Yahoo Finance: หุ้นไทย (`PTT.BK`), SET (`^SET.BK`), หุ้น US, ทองคำ (`GC=F` → ทองแท่งไทย 96.5% `GOLD_TH`), USD/THB;
  NAV กองทุนไทยจาก SEC Open API (ถ้ามีคีย์); พันธบัตร/อื่น ๆ กรอกเองหรือให้ AI อัปเดต · Vercel Cron ดึงราคาทุกวันทำการ 18:30 น.
- **AI integration** — MCP server สำหรับ Claude และ OpenAPI สำหรับ ChatGPT Custom GPT → ดู [docs/AI_SETUP.md](docs/AI_SETUP.md)

## Tech stack
Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · Recharts · Postgres + Drizzle ORM · zod · MCP TypeScript SDK · Vitest

```
src/
  lib/finance/      สูตรการเงิน (pure functions + tests): returns, risk, ratios, mpt, portfolio, allocation, metrics
  lib/prices/       Yahoo Finance, SEC Thailand, ราคาทองไทย
  server/services/  business logic ที่ UI, REST API และ MCP ใช้ร่วมกัน
  server/mcp.ts     MCP tools · server/openapi.ts  OpenAPI spec
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

4. รัน migration ครั้งแรกจากเครื่องตัวเอง: `DATABASE_URL=<neon url> npm run db:migrate`
5. Deploy → เข้าเว็บ → ตั้ง risk-free rate และเป้า allocation ในหน้า **ตั้งค่า** → เพิ่มสินทรัพย์ → กด **ดึงราคาล่าสุด**

## วิธีคิดที่ควรรู้
- รายการ `buy/sell` ใช้ `quantity × price` (สกุลเงินของสินทรัพย์); `dividend/coupon/deposit/withdraw/fee` ใส่จำนวนเงินรวมใน `price`
- ถ้าไม่ได้บันทึกการฝากเงิน ระบบจะถือว่าเงินที่ใช้ซื้อมาจากภายนอก (implicit deposit) ทำให้ TWR/XIRR ยังถูกต้อง
- เงินสดในพอร์ตเก็บเป็นบาท; ต้นทุนสินทรัพย์ USD ใช้อัตราแลกเปลี่ยน ณ วันซื้อ, มูลค่าปัจจุบันใช้อัตราล่าสุด (รวมผลค่าเงิน)
- ผลตอบแทนช่วงสั้นกว่า 1 ปีจะไม่ถูกแปลงเป็นรายปี (ไม่ extrapolate)
- MPT ใช้ข้อมูลในอดีตซึ่งมี estimation error สูง ใช้ประกอบการตัดสินใจ ไม่ใช่คำแนะนำการลงทุน

## ข้อจำกัด
- Yahoo Finance เป็น API ไม่เป็นทางการ อาจเปลี่ยนหรือจำกัดการใช้งาน — กรอกราคาเองได้เสมอ
- ราคาทองแท่งสมาคมค้าทองคำไม่มี API ฟรี จึงประมาณจาก spot × USDTHB (อาจต่างจากราคาประกาศเล็กน้อย)
- SEC Open API ต้องสมัครคีย์ฟรี; ถ้าไม่มีให้ใช้ priceSource `manual`
