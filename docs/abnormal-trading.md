# ตรวจการซื้อขายผิดปกติ (Abnormal Trading Detection)

ใช้กับหุ้นไทย (`thai_stock`) เท่านั้น ระบบหาวันที่ผลตอบแทนหรือปริมาณการซื้อขายต่างจากปกติของหุ้นตัวนั้นอย่างมีนัยสำคัญทางสถิติ
และบอกว่ามีข่าว (event) ตามมาภายในกี่วัน

> **เป็นสัญญาณทางสถิติ ไม่ใช่หลักฐานการกระทำผิด** — ราคาและ volume ผิดปกติเกิดได้จากหลายสาเหตุ
> (ข่าวทั่วไป, กองทุนปรับพอร์ต, ข้อมูลผิดพลาด) ต้องตรวจสอบเพิ่มเติมเสมอ

ทุกผลลัพธ์ (MCP, REST, หน้าเว็บ) มาจาก service เดียวกัน (`src/server/services/abnormal.ts`)
และระบุ model, benchmark, ช่วงวันที่, จำนวน observation (n), คำเตือนเรื่องข้อมูล และข้อความข้างบนนี้

## ข้อมูลที่ใช้

| ข้อมูล | ที่มา | ถ้าไม่มี |
|---|---|---|
| ราคาปิด / adjusted close รายวัน | `prices` (Yahoo หรือ import) | คำนวณไม่ได้ |
| Volume รายวัน (หน่วยหุ้น) | `prices.volume` จาก `sync_historical_prices` หรือคอลัมน์ volume ใน `import_prices` | z ของ volume เป็น null + เหตุผล |
| จำนวนหุ้น (shares outstanding) | `set_shares_outstanding` พร้อมแหล่งที่มา (effective-dated) | ใช้ raw volume แทน turnover + คำเตือน |
| ดัชนีตลาด | `SETTRI` (Total Return Index) ผ่าน `import_prices target: "benchmark"` หรือ `^SET.BK` (ดัชนีราคา) | AR / CAR เป็น null + เหตุผล |
| Events | `record_event` (earnings / ma / xd / news / other) และวัน XD จากข้อมูลปันผล (อ่านอย่างเดียว) | ไม่มีป้าย "ก่อน event" |

ระบบ **ไม่เดาค่าที่ไม่มี**: วันที่ไม่มี volume ไม่ถือเป็น 0, ไม่ interpolate ราคา, ไม่ประมาณจำนวนหุ้น — ค่าที่คำนวณไม่ได้เป็น `null` พร้อมเหตุผล

## การเลือก benchmark (ไม่ผสมฐาน)

- ถ้ามี `SETTRI` และหุ้นมี adjusted close ≥ 95% ของวันที่มี TRI → **adjusted close เทียบ TRI** (ผลตอบแทนรวมปันผลทั้งสองฝั่ง)
- ไม่อย่างนั้น → **ราคาปิดเทียบดัชนีราคา** (`settings.benchmarkSymbol`, ค่าเริ่มต้น `^SET.BK`) พร้อมคำเตือน
  วัน XD ผลตอบแทนหุ้นจะต่ำกว่าจริงตามปันผล จึงมีคำเตือนรายวันทุกวัน XD และ CAR ที่ครอบวัน XD
- ไม่ใช้ adjusted close คู่กับดัชนีราคา หรือราคาปิดคู่กับ TRI เด็ดขาด

## Abnormal Return (event study) — `run_event_study`

ผลตอบแทนอย่างง่าย R_t = P_t / P_{t−1} − 1 บนวันที่ทั้งหุ้นและดัชนีมีราคาจริงทั้งสองวัน (วันที่ขาดถูกข้ามและนับไว้ใน `coverage.skipped`)

- **วัน 0** = วันที่ข่าวออก ถ้าไม่ใช่วันซื้อขายใช้วันซื้อขายถัดไป
- **Estimation window** ค่าเริ่มต้น [−250, −30] วันซื้อขาย ต้องมี ≥ 120 observation ไม่อย่างนั้นคืน `INSUFFICIENT_DATA` พร้อมเหตุผล
- **Event window** ค่าเริ่มต้น [−10, +10]

Expected return (fit บน estimation window):

| Model | สูตร | ใช้เมื่อ |
|---|---|---|
| `market` (ค่าเริ่มต้น) | E[R_i,t] = α + β·R_m,t (OLS) | ทั่วไป |
| `dimson` | R_i,t = α + β₋₁R_m,t−1 + β₀R_m,t + β₊₁R_m,t+1 + ε; β = β₋₁+β₀+β₊₁ | หุ้นซื้อขายไม่ต่อเนื่อง (volume = 0 > 10%) |
| `market_adjusted` | E[R_i,t] = R_m,t (α = 0, β = 1) | ประวัติสั้น / ตรวจซ้ำ |

- AR_t = R_i,t − E[R_i,t]
- σ(ε) = √(SSE / (n − k)) ของ residual ใน estimation window (k = จำนวนพารามิเตอร์)
- t ของ AR = AR_t / σ(ε)
- CAR(t₁, t₂) = Σ AR_t, t = CAR / (σ(ε)·√L) โดย L = จำนวนวันในช่วง
- ผลลัพธ์มี CAR หลายช่วง: ก่อนข่าว [−10, −1] (run-up), 5 วันก่อนข่าว [−5, −1], วันข่าว [0, +1], ทั้งช่วง
- ผลลัพธ์มี α, β, σ(ε), R², n และ volume z ของวันเดียวกัน

t-test นี้สมมติว่า residual เป็นอิสระและความแปรปรวนคงที่ (ไม่ปรับ event-induced variance หรือ autocorrelation)

## Abnormal Volume (mean-adjusted) — `get_abnormal_volume`

ตาม Campbell & Wasley (1996):

- turnover_t = volume_t / shares outstanding ที่มีผล ณ วัน t
- V_t = ln(turnover_t + 0.00000255) (ค่าคงที่ทำให้วัน volume = 0 ไม่เป็น −∞)
- z_t = (V_t − mean(V)) / sd(V) บน estimation window ของหุ้นตัวเอง [t−250, t−30] (≥ 120 วัน)
- ถ้าไม่มีจำนวนหุ้นครอบคลุมทุกวัน → V_t = ln(volume_t + 1) ทั้งชุด พร้อมคำเตือน (z ของหุ้นตัวเดียวใช้ได้ เทียบข้ามหุ้นไม่ได้)
- ระดับ: |z| > 2 น่าสังเกต, > 3 ผิดปกติ (ปรับได้)

## Daily scan — `scan_abnormal_trading`

ทุกวันซื้อขาย t ในช่วงที่เลือก (หุ้นไทยทุกตัวที่ไม่ archived หรือเฉพาะที่ระบุ):

1. Market model fit ใหม่บน [t−250, t−30] (rolling, ใช้ prefix sums — ผลตรงกับ OLS ตรง ๆ ถึง 1e-10)
2. AR_t, t_AR = AR_t / σ(ε)
3. Volume z_t (ข้างบน)
4. CAR 5 วัน (t−4 … t) ด้วย fit ของวัน t, t_CAR5 = CAR5 / (σ(ε)·√5)

| ระดับ | เกณฑ์ (ค่าเริ่มต้น, ปรับได้) |
|---|---|
| **ผิดปกติ** | (\|t_AR\| > 3 **และ** z > 3) **หรือ** \|t_CAR5\| > 3 |
| **น่าสังเกต** | (\|t_AR\| > 2 **และ** z > 2) **หรือ** \|t_CAR5\| > 2 |
| ปกติ | อื่น ๆ |

- ถ้ามี event ภายใน 10 วันซื้อขายหลังวันที่ถูก flag → ป้าย **"ผิดปกติก่อน event X วัน"**
- เรียงตามระดับ แล้วค่า |t| หรือ z ที่สูงสุด แล้ววันที่ล่าสุด
- **Spike วันเดียว** ทำให้ CAR5 สูงต่ออีก 4 วัน (หน้าต่างยังครอบวันนั้น) วันเหล่านั้นยังถูก flag ตามเกณฑ์
  แต่มีหมายเหตุ "CAR 5 วันสูงเพราะวัน X วันเดียว — ไม่ใช่การสะสมหลายวัน"
  การสะสมแบบทยอยหลายวันจะไม่มีหมายเหตุนี้
- วันที่ไม่มีข้อมูลดัชนีพอ → AR/CAR5 เป็น null และไม่ถูก flag จากผลตอบแทน ถ้า volume สูงจะอยู่ใน `volumeOnly` แยกต่างหาก
  (ไม่ลดเกณฑ์และไม่เดา AR)
- ที่ |t| > 2 คาดว่าจะมีวันถูก flag โดยบังเอิญราว 5% ของวัน แม้ไม่มีอะไรเกิดขึ้น — ยิ่งสแกนหลายวันหลายหุ้นยิ่งเจอมาก

## คุณภาพข้อมูล — `get_data_quality`

รายการ "ข้อมูลตรวจการซื้อขายผิดปกติ" (และ `abnormalTrading` รายหุ้น) สำหรับหุ้นไทยที่ไม่ archived:

| รหัส | ความหมาย |
|---|---|
| `NO_VOLUME` / `PARTIAL_VOLUME` | ไม่มี volume / มีไม่ครบ |
| `NO_SHARES` | ไม่มีจำนวนหุ้น (ใช้ raw volume) |
| `SHORT_HISTORY` | ราคาย้อนหลัง < 150 วันซื้อขาย (120 obs ที่จบ 30 วันก่อน) |
| `THIN_TRADING` | volume = 0 เกิน 10% ของวัน — แนะนำ Dimson |
| market | ยังไม่มี SETTRI / ดัชนีมีข้อมูลไม่ถึง 150 วัน |

## Tools และ API

| MCP tool | REST |
|---|---|
| `scan_abnormal_trading` | `GET /api/v1/abnormal/scan?symbols=&from=&to=&notable=&abnormal=` |
| `run_event_study` | `GET /api/v1/abnormal/event-study?symbol=&eventDate=\|eventId=&model=` |
| `get_abnormal_volume` | `GET /api/v1/abnormal/volume?symbol=&from=&to=` |
| `list_events` / `record_event` / `delete_event` | `GET/POST /api/v1/stock-events`, `DELETE /api/v1/stock-events/{id}?symbol=&confirmDelete=true` |
| `set_shares_outstanding` | `GET/POST /api/v1/shares-outstanding` |
| — (หน้าสินทรัพย์) | `GET /api/v1/assets/{id}/abnormal?from=&to=` |

นำเข้า SET TRI: `import_prices` ด้วย `target: "benchmark"` และ symbol `SETTRI` (CSV คอลัมน์ Date, Close)

## โค้ดและการทดสอบ

- Pure: `src/lib/finance/abnormal/{returns,volume,scan,quality}.ts` + tests (golden values จาก numpy, ข้อมูลสังเคราะห์ที่ฝัง spike / drift)
- Service: `src/server/services/{abnormal,stock-data}.ts`; MCP: `src/server/mcp-abnormal.ts`
- `npm run check:abnormal-data` (ชั้นข้อมูล) และ `npm run check:abnormal` (MCP in-memory + HTTP บนฐานข้อมูลในเครื่อง)
- Migration 0018 (additive) ย้อนกลับได้ด้วย `drizzle/rollback/0018_abnormal_trading.down.sql` (ลบเฉพาะ volume / ตารางใหม่ ราคาเดิมไม่กระทบ)

## ข้อจำกัด

- Volume จาก Yahoo เป็นข้อมูลไม่เป็นทางการ อาจขาดหรือคลาดเคลื่อนบางวัน
- ไม่มีข้อมูลรายนักลงทุน / big lot / NVDR — ตรวจได้เฉพาะระดับราคาและปริมาณรวม
- t-test พื้นฐาน (ไม่มี Patell / BMP / Corrado) และไม่รวม CAAR ข้ามหุ้น
- Event window หรือ estimation window ที่มีข่าวอื่นปนอยู่ทำให้ผลเพี้ยนได้

## อ้างอิง

- MacKinlay, A. C. (1997). Event Studies in Economics and Finance. *Journal of Economic Literature*, 35(1), 13–39.
- Brown, S. J., & Warner, J. B. (1985). Using Daily Stock Returns: The Case of Event Studies. *Journal of Financial Economics*, 14(1), 3–31.
- Campbell, C. J., & Wasley, C. E. (1996). Measuring Abnormal Daily Trading Volume for Samples of NYSE/ASE and NASDAQ Securities Using Parametric and Nonparametric Test Statistics. *Review of Quantitative Finance and Accounting*, 6(3), 309–326.
- Dimson, E. (1979). Risk Measurement When Shares Are Subject to Infrequent Trading. *Journal of Financial Economics*, 7(2), 197–226.
