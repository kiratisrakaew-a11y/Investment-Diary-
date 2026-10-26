"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";

type Turn = { role: "user" | "assistant"; content: string; tools?: string[] };

const SUGGESTIONS = [
  "วิเคราะห์พอร์ตของฉันตอนนี้ ความเสี่ยงและผลตอบแทนเป็นอย่างไรเมื่อเทียบกับ SET",
  "แนะนำน้ำหนักการลงทุนแต่ละสินทรัพย์ตาม Modern Portfolio Theory ถ้าฉันรับความเสี่ยงได้ปานกลาง (A = 4) และจำกัดไม่เกิน 35% ต่อตัว",
  "ช่วยประเมินมูลค่า PTT ด้วย DCF และ DDM ใช้ข้อมูลจาก Yahoo และอธิบายสมมติฐาน",
  "พันธบัตรในพอร์ตมี duration เท่าไร ถ้าดอกเบี้ยขึ้น 1% ราคาจะเปลี่ยนเท่าไร",
  "พอร์ตเบี่ยงจากเป้าหมาย asset allocation แค่ไหน ควร rebalance อย่างไร",
];

const TOOL_LABEL: Record<string, string> = {
  get_portfolio_summary: "พอร์ต",
  get_allocation: "allocation",
  get_performance_metrics: "ผลการดำเนินงาน",
  get_investment_universe: "ข้อมูลสินทรัพย์",
  optimize_portfolio: "optimizer",
  value_security: "ประเมินมูลค่า",
  analyze_bond: "คำนวณพันธบัตร",
  get_bond_holdings: "พันธบัตรในพอร์ต",
  get_fundamentals: "งบการเงิน (Yahoo)",
  list_valuations: "valuation ที่บันทึก",
  search_notes: "บันทึก",
  save_note: "บันทึกลงไดอารี่",
  save_valuation: "บันทึก valuation",
};

export function AdvisorChat({
  threadId: initialId,
  initial,
  threads,
}: {
  threadId: number | null;
  initial: Turn[];
  threads: { id: number; title: string }[];
}) {
  const router = useRouter();
  const [threadId, setThreadId] = useState(initialId);
  const [turns, setTurns] = useState<Turn[]>(initial);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [turns, pending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || pending) return;
    setError(null);
    setInput("");
    setTurns((t) => [...t, { role: "user", content: message }]);
    setPending(true);
    try {
      const res = await fetch("/api/advisor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTurns((t) => [...t, { role: "assistant", content: data.reply, tools: data.toolsUsed }]);
      if (!threadId) {
        setThreadId(data.threadId);
        router.replace(`/advisor?thread=${data.threadId}`);
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setTurns((t) => t.slice(0, -1));
      setInput(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-4">
      <aside className="space-y-2 lg:col-span-1">
        <Link href="/advisor" className="btn w-full">+ บทสนทนาใหม่</Link>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {threads.map((t) => (
            <Link
              key={t.id}
              href={`/advisor?thread=${t.id}`}
              className={clsx("block truncate rounded-md px-2 py-1.5 text-sm", t.id === threadId ? "bg-accent/10 text-accent" : "text-muted hover:text-text")}
            >
              {t.title}
            </Link>
          ))}
        </div>
      </aside>

      <section className="card flex min-h-[70vh] flex-col lg:col-span-3">
        <div className="flex-1 space-y-5 overflow-y-auto pb-4">
          {turns.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                AI ที่ปรึกษาอ่านพอร์ตจริงของคุณ และใช้เครื่องมือคำนวณของแอป (DCF, DDM, bond YTM/duration, Markowitz optimizer) ก่อนตอบ
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="btn-ghost text-left text-xs">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={clsx("flex", t.role === "user" && "justify-end")}>
              <div className={clsx("max-w-[92%] rounded-xl px-4 py-3 text-sm", t.role === "user" ? "bg-accent/10" : "border border-border")}>
                {t.role === "assistant" ? (
                  <div className="prose-note advisor-md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.content}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{t.content}</p>
                )}
                {t.tools && t.tools.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1 border-t border-border/60 pt-2">
                    {t.tools.map((n) => (
                      <span key={n} className="rounded-full bg-bg px-2 py-0.5 text-[11px] text-muted">🔧 {TOOL_LABEL[n] ?? n}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {pending && <div className="animate-pulse text-sm text-muted">กำลังวิเคราะห์ข้อมูลพอร์ตและคำนวณ…</div>}
          <div ref={bottom} />
        </div>
        {error && <p className="mb-2 text-sm text-neg">{error}</p>}
        <form
          className="flex gap-2 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            className="input min-h-[44px] flex-1 resize-y"
            rows={2}
            value={input}
            placeholder="ถามเรื่องพอร์ต การประเมินมูลค่า พันธบัตร หรือการจัดสัดส่วน…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <button className="btn self-end" disabled={pending || !input.trim()}>
            ส่ง
          </button>
        </form>
      </section>
    </div>
  );
}
