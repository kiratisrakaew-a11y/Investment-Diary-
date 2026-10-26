/**
 * Guard against percent / decimal mix-ups: the engine takes decimals (7% = 0.07),
 * so a value like 2.5 for a risk-free rate almost certainly means 2.5%.
 */
const LIMITS: Record<string, { label: string; max: number }> = {
  riskFree: { label: "Risk-free rate", max: 0.25 },
  equityRiskPremium: { label: "ERP", max: 0.25 },
  extraPremium: { label: "Premium เพิ่ม", max: 0.25 },
  costOfDebt: { label: "ต้นทุนหนี้ (Kd)", max: 0.5 },
  terminalGrowth: { label: "Terminal growth", max: 0.2 },
  growthStart: { label: "Growth ปีแรก", max: 2 },
  growthEnd: { label: "Growth ปีสุดท้าย", max: 2 },
  highGrowth: { label: "Growth ช่วงแรก", max: 2 },
  ebitMarginStart: { label: "EBIT margin ปีแรก", max: 1 },
  ebitMarginEnd: { label: "EBIT margin ปีสุดท้าย", max: 1 },
  roe: { label: "ROE", max: 1.5 },
  terminalRoic: { label: "Terminal ROIC", max: 1.5 },
  terminalRoe: { label: "Terminal ROE", max: 1.5 },
  couponRate: { label: "อัตราคูปอง", max: 0.5 },
};

export function rateScaleWarnings(fields: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const lim = LIMITS[k];
    if (!lim || typeof v !== "number" || !Number.isFinite(v)) continue;
    if (Math.abs(v) > lim.max) {
      out.push(`${lim.label} = ${(v * 100).toFixed(1)}% ดูสูงผิดปกติ — ระบบใช้ทศนิยม (7% = 0.07) อาจใส่ ${v} ที่ตั้งใจเป็น ${v}% หรือไม่`);
    }
  }
  return out;
}
