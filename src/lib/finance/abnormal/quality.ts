/**
 * Data readiness for abnormal-trading analysis (pure): what each Thai stock is missing before
 * AR / abnormal volume can be computed, and whether the market side (TRI / price index) is enough.
 * Only reports; never fills or estimates anything.
 */
import { DEFAULT_ESTIMATION, MIN_VOLUME_OBS } from "./volume";

/** Trading days of history needed for the latest day to have a full minimum estimation window (≥ 120 obs ending 30 days before). */
export const MIN_HISTORY_DAYS = MIN_VOLUME_OBS - DEFAULT_ESTIMATION[1];
export const THIN_TRADING_SHARE = 0.1;

export interface AbnormalStockData {
  symbol: string;
  /** Days with a stored price. */
  priceDays: number;
  /** Days with a known volume (0 included). */
  volumeDays: number;
  zeroVolumeDays: number;
  sharesRecorded: boolean;
}
export interface AbnormalMarketData {
  triSymbol: string;
  triDays: number;
  indexSymbol: string;
  indexDays: number;
}

export type AbnormalIssueCode =
  | "NO_VOLUME"
  | "PARTIAL_VOLUME"
  | "NO_SHARES"
  | "SHORT_HISTORY"
  | "THIN_TRADING";

export function abnormalDataQuality(
  stocks: AbnormalStockData[],
  market: AbnormalMarketData,
) {
  const out = stocks.map((s) => {
    const issues: { code: AbnormalIssueCode; message: string }[] = [];
    if (s.volumeDays === 0)
      issues.push({
        code: "NO_VOLUME",
        message:
          "ไม่มีข้อมูล volume — sync_historical_prices อีกครั้งเพื่อดึง volume",
      });
    else if (s.volumeDays < s.priceDays)
      issues.push({
        code: "PARTIAL_VOLUME",
        message: `มี volume ${s.volumeDays}/${s.priceDays} วัน — วันที่ไม่มีไม่นับ (ไม่ถือเป็น 0)`,
      });
    if (!s.sharesRecorded)
      issues.push({
        code: "NO_SHARES",
        message:
          "ไม่มีจำนวนหุ้น (shares outstanding) — volume ใช้ raw volume แทน turnover (เทียบข้ามหุ้นไม่ได้) บันทึกด้วย set_shares_outstanding พร้อมแหล่งที่มา",
      });
    if (s.priceDays < MIN_HISTORY_DAYS)
      issues.push({
        code: "SHORT_HISTORY",
        message: `ราคาย้อนหลัง ${s.priceDays} วันซื้อขาย ต้องมี ≥ ${MIN_HISTORY_DAYS} วันสำหรับ estimation window (≥ ${MIN_VOLUME_OBS} obs จนถึง 30 วันก่อน)`,
      });
    const share = s.volumeDays ? s.zeroVolumeDays / s.volumeDays : 0;
    if (share > THIN_TRADING_SHARE)
      issues.push({
        code: "THIN_TRADING",
        message: `วันที่ volume = 0 มี ${(share * 100).toFixed(1)}% (> 10%) — ซื้อขายไม่ต่อเนื่อง แนะนำ Dimson model ใน run_event_study`,
      });
    return { symbol: s.symbol, zeroVolumeShare: share, issues };
  });
  const marketIssues: string[] = [];
  if (market.triDays === 0) {
    marketIssues.push(
      `ยังไม่มี ${market.triSymbol} (SET Total Return Index) — AR ใช้ราคาปิดเทียบดัชนีราคา ${market.indexSymbol} วัน XD จะมีคำเตือน · import ด้วย import_prices target "benchmark"`,
    );
    if (market.indexDays < MIN_HISTORY_DAYS)
      marketIssues.push(
        `ดัชนี ${market.indexSymbol} มีข้อมูล ${market.indexDays} วัน ต้องมี ≥ ${MIN_HISTORY_DAYS} วัน — คำนวณ AR / CAR ไม่ได้จนกว่าจะ import ดัชนีย้อนหลัง`,
      );
  } else if (market.triDays < MIN_HISTORY_DAYS) {
    marketIssues.push(
      `${market.triSymbol} มีข้อมูล ${market.triDays} วัน ต้องมี ≥ ${MIN_HISTORY_DAYS} วัน`,
    );
  }
  return {
    stocks: out,
    market: marketIssues,
    ok: marketIssues.length === 0 && out.every((s) => s.issues.length === 0),
  };
}

export type AbnormalDataQuality = ReturnType<typeof abnormalDataQuality>;
