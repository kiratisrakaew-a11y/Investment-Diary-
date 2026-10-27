/**
 * "อธิบาย" button: one Claude call (no tools) that explains the numbers a page section shows
 * in plain Thai with a worked example. The client sends the exact values rendered on screen, so
 * the explanation never needs to fetch or guess data. Results are cached in memory by content.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AdvisorNotConfigured } from "./advisor";
import { today } from "@/lib/validation";

const MODEL = process.env.EXPLAIN_MODEL ?? process.env.ADVISOR_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.EXPLAIN_EFFORT ?? "low") as "low" | "medium" | "high";
/** Upper bound on the serialized values; a section's figures are far smaller than this. */
export const MAX_DATA_CHARS = 24_000;

export const explainInput = z.object({
  topic: z.string().min(1).max(200).describe("Section title, e.g. 'ผลตอบแทนและความเสี่ยง'"),
  page: z.string().max(100).optional(),
  hint: z.string().max(1000).optional().describe("What the section is about / formulas used"),
  data: z.unknown().describe("The values shown in the section (JSON)"),
});
export type ExplainInput = z.infer<typeof explainInput>;

const SYSTEM = `คุณคือผู้ช่วยในแอป Investment Diary (บันทึกการลงทุนส่วนตัว สกุลเงินหลักบาท) หน้าที่เดียวคือ "แปลความหมาย" ตัวเลขที่ผู้ใช้เห็นบนหน้าจอให้คนทั่วไปเข้าใจง่าย ตอบเป็นภาษาไทย

วิธีอธิบาย
- เริ่มด้วย "สรุปสั้น ๆ" 1–2 ประโยค ว่าตัวเลขชุดนี้บอกอะไรเกี่ยวกับพอร์ตนี้
- จากนั้นอธิบายทีละค่าที่สำคัญ (หัวข้อย่อยตัวหนา): ค่านี้คืออะไร (ภาษาง่าย ไม่ใช้ศัพท์เทคนิคโดยไม่อธิบาย) → ค่าของพอร์ตนี้แปลว่าอะไร → ยกตัวอย่างเป็นตัวเลขจับต้องได้ เช่น "ถ้าลงทุน 100,000 บาท …" หรือเปรียบเทียบกับสิ่งในชีวิตประจำวัน
- ถ้ามีเกณฑ์ทั่วไปที่ใช้อ่านค่า (เช่น Sharpe > 1 ถือว่าดี) ให้บอกพร้อมเตือนว่าเป็นเกณฑ์คร่าว ๆ
- ค่าที่เป็น null / "–" / ข้อมูลไม่พอ ให้อธิบายว่าทำไมยังคำนวณไม่ได้ และต้องมีอะไรเพิ่ม
- ปิดท้ายด้วย "ข้อควรระวัง" สั้น ๆ ถ้ามี (เช่น ข้อมูลสั้น ผลในอดีตไม่รับประกันอนาคต)

กติกา
- ใช้เฉพาะตัวเลขที่ให้มา ห้ามแต่งตัวเลขพอร์ต ราคา หรือข้อมูลตลาดเพิ่ม ตัวเลขในตัวอย่างสมมติต้องบอกว่าเป็นตัวอย่าง
- ค่าที่เป็นทศนิยมของสัดส่วน (เช่น 0.0206) ให้แปลงเป็นเปอร์เซ็นต์ (2.06%) เมื่อชื่อฟิลด์หรือบริบทบอกว่าเป็นอัตรา/ผลตอบแทน/น้ำหนัก
- ไม่แนะนำให้ซื้อหรือขายหลักทรัพย์ใด ไม่ใช่คำแนะนำการลงทุน
- กระชับ: ไม่เกินประมาณ 350 คำ ใช้ markdown (หัวข้อตัวหนา, bullet) ไม่ต้องทำตารางใหญ่`;

const cache = new Map<string, { at: number; text: string }>();
const TTL_MS = 6 * 60 * 60 * 1000;

export function explainCacheKey(x: ExplainInput) {
  return createHash("sha256").update(JSON.stringify([x.topic, x.page, x.hint, x.data])).digest("hex");
}

export function buildExplainPrompt(x: ExplainInput, serialized: string) {
  return [
    `หน้า: ${x.page ?? "-"}`,
    `หัวข้อ: ${x.topic}`,
    x.hint ? `บริบท/สูตรที่ใช้: ${x.hint}` : null,
    `ค่าที่แสดงบนหน้าจอ (JSON):\n${serialized}`,
    `วันนี้: ${today()}`,
    "ช่วยอธิบายความหมายของค่าเหล่านี้แบบเข้าใจง่าย พร้อมยกตัวอย่าง",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function explainValues(input: unknown): Promise<{ text: string; cached: boolean }> {
  const x = explainInput.parse(input);
  const serialized = JSON.stringify(x.data ?? null, null, 1);
  if (serialized.length > MAX_DATA_CHARS) throw new Error(`ข้อมูลยาวเกินไป (${serialized.length} ตัวอักษร > ${MAX_DATA_CHARS})`);
  const key = explainCacheKey(x);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { text: hit.text, cached: true };

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new AdvisorNotConfigured("ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY ใน environment variables — ปุ่มอธิบายต้องใช้ AI");
  }
  const client = new Anthropic();
  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT },
    // Re-run declined requests on a suitable fallback model instead of stopping.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildExplainPrompt(x, serialized) }],
  });
  if (msg.stop_reason === "refusal") return { text: "ขออภัย ไม่สามารถอธิบายส่วนนี้ได้", cached: false };
  const text =
    msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() || "(ไม่มีคำอธิบาย)";
  const out = msg.stop_reason === "max_tokens" ? `${text}\n\n_(คำอธิบายถูกตัดเพราะยาวเกิน)_` : text;
  cache.set(key, { at: Date.now(), text: out });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return { text: out, cached: false };
}
