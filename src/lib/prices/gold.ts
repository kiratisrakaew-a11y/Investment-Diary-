/**
 * Thai gold-bar price (THB per 1 baht-weight, 96.5%) derived from spot gold.
 * There is no free official API for the Gold Traders Association price, so we
 * approximate: USD/oz × USDTHB ÷ 31.1035 g/oz × 15.244 g × 0.965 purity.
 * Use manual prices if you need the exact association quote.
 */
export const THAI_GOLD_SYMBOL = "GOLD_TH";
const GRAMS_PER_TROY_OZ = 31.1035;
const GRAMS_PER_BAHT_WEIGHT = 15.244;
const PURITY = 0.965;

export function thaiGoldPrice(usdPerOz: number, usdThb: number): number {
  return (usdPerOz * usdThb * GRAMS_PER_BAHT_WEIGHT * PURITY) / GRAMS_PER_TROY_OZ;
}
