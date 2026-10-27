# รายงานส่งมอบ Unified Roadmap PR0–PR16 (27 ต.ค. 2026)

Branch `claude/vigilant-fermi-tf3wq7` · commit `89c81b0` → HEAD · 77 ไฟล์ (+8,472 / −125) · ไม่ได้ deploy

## Commit แยกตาม PR

| Commit | เนื้อหา |
|---|---|
| `89c81b0` | Phase A: gap audit (PR0, PR8, PR11) และ baseline ของ optimizer |
| `e57256b` | PR1: metadata ของพันธบัตร และเกณฑ์ว่าใช้แทนอัตราปลอดความเสี่ยงได้หรือไม่ |
| `8b788f1` | PR2: ตัวหา risk-free rate จาก curve สกุลเดียวกัน (สำรองด้วยค่าในหน้าตั้งค่า ระบุเองได้ถ้ามีเหตุผล) |
| `62af7df`, `ac30ed3` | PR3: ผลตอบแทนรวมของพันธบัตร (dirty price + คูปองที่วัน ex) และ resample รายสัปดาห์/รายเดือน |
| `df41a7e` | PR4: optimizer รู้จักพันธบัตร (carry / rolldown / shock / PD×LGD) จำกัดตามสกุลเงินและอายุคงเหลือ |
| `786c9fa` | PR5: ขายชอร์ต (ปิดเป็นค่าเริ่มต้น จำกัด gross ด้วย auxiliary variables) และสวิตช์กู้ที่อัตราปลอดความเสี่ยงแยกต่างหาก |
| `e770d07` | PR6: UI optimizer แบบกะทัดรัด สวิตช์ short และกราฟ long/short |
| `fc4c9a6` | PR9 + PR10: ซ่อน / เก็บถาวร / ลบแบบมีเงื่อนไข และความสอดคล้องข้ามฟีเจอร์ |
| `e85598e` | PR11 + PR12: scenario engine กลางใช้ได้ทุกวิธี (SOTP คำนวณใหม่ทั้งสะพาน) |
| `bbab888` | PR13 + PR14: sensitivity, reverse DCF และ Monte Carlo แบบกำหนด seed |
| `6236474` | PR15: บันทึกผล, REST/MCP, คำอธิบายภาษาไทย และแท็บ UI |
| (commit นี้) | PR7 + PR16: รายงานนี้ |

## ผลการตรวจ (รันจริง)

| คำสั่ง | ผล |
|---|---|
| `npx vitest run` | 53 ไฟล์ · 545 tests ผ่าน |
| `npx tsc --noEmit -p .` | ผ่าน (exit 0) |
| `npm run lint` | ไม่มี warning / error |
| `npm run build` | Compiled successfully |
| `npm run db:migrate` | Migrations applied (exit 0) |
| `npm run check:asset-lifecycle` | 13/13 ผ่าน (ล้างข้อมูลทดสอบเอง) |
| `npm run check:valuation-roundtrip` | ผ่านทั้งหมด |
| `npm run check:scenario-parity` | 20/20 ผ่าน: record เดิมไม่เปลี่ยน, ปฏิเสธ 25/50/20, base แยกจาก weighted, REST = MCP = service, ไม่มี key ได้ 401 |
| เทียบ optimizer กับ baseline (6 objective) | ต่างสูงสุด 0 (ค่าเริ่มต้นไม่เปลี่ยน) |
| `e2e/valuation-smoke.mjs` (375–1440 px สองธีม) | ALL PASSED |
| REST optimize ใส่ minWeight −10% | 400 `SHORT_SELLING_DISABLED` · ไม่มี key ได้ 401 |
| Playwright หน้า holdings และ scenario workbench | ไม่มี console error · มือถือไม่มี scroll แนวนอน |

ข้อมูลทดสอบ (TLC-*, TEST-LOCAL) ลบหมดแล้ว · ฐานข้อมูลกลับเป็น 6 assets / 17 transactions / 3,120 prices / 3 valuations

## Migration (additive เท่านั้น)

- **0013 `asset_bond_terms`:** เพิ่ม `assets.bond_terms` (jsonb, nullable)
- **0014 `asset_lifecycle`:** เพิ่ม `assets.hidden_in_holdings_at`, `assets.archived_at` (nullable) และตาราง `asset_lifecycle_events` (ไม่มี FK)
- **Rollback:** ลบ 2 คอลัมน์ ตาราง events และ `bond_terms` ได้โดยไม่กระทบข้อมูลเดิม (โค้ดเก่าไม่อ่านค่าเหล่านี้)
- **Scenario (PR11–15):** ไม่มี migration ใช้ JSON เดิม (`assumptions.scenarioSet`, `result.scenarioAnalysis` / `monteCarlo`)

## สิ่งที่ทำไม่ได้หรือจำกัด

- **PLANB valuation #31 และพอร์ตจริง (AP / BBL / KBANK / PLANB / SCB / TISCO):** อยู่ในฐานข้อมูล production ที่เข้าไม่ถึงจาก environment นี้
  - ทดสอบด้วย fixture สังเคราะห์ที่มีโครงสร้างเดียวกัน
  - โค้ดไม่แก้ record เก่า: ค่า Base 5.39 คงเดิมจนกว่าผู้ใช้จะเพิ่ม scenario แล้วกดบันทึกเอง
- **ข้อมูลตลาด:** ไม่มีข้อมูลจริงของ yield curve, COM7 หรือ iCare ในเครื่องนี้ ระบบจึงไม่สร้างตัวเลขให้
  - iCare ไม่ถูกนับอัตโนมัติ
- **Monte Carlo:**
  - กำหนด correlation ได้ทาง API / MCP เท่านั้น (UI ยังสุ่มแบบอิสระ)
  - ผลเป็นการกระจายตามที่ผู้ใช้กำหนด ไม่ใช่ความน่าจะเป็นที่สอบเทียบแล้ว
- **Scenario ของพันธบัตร:** ใช้ได้ทาง API / MCP (หน้าพันธบัตรไม่มี editor valuation)
- **ไม่อยู่ในขอบเขต:** Decision Tree และ event-driven valuation

## ภาพหน้าจอ

อยู่ใน scratchpad ของ session (ไม่ได้ commit): `pr6before/after-*`, `pr9before/after-holdings.png`, `pr9-holdings-{dim,light}.png`, `pr15-*.png`
