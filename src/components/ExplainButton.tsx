"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";

export interface ExplainSpec {
  /** The values shown on screen (keep it to what the section displays). */
  data: unknown;
  /** Formulas / context that help the explanation. */
  hint?: string;
}

// Small non-cryptographic hash for the per-tab cache key.
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const Sparkle = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={clsx("size-3.5", className)} aria-hidden>
    <path d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" />
  </svg>
);

export function ExplainButton({ topic, data, hint, label = "อธิบาย", className }: { topic: string; label?: string; className?: string } & ExplainSpec) {
  const page = usePathname();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });
  const payload = JSON.stringify({ topic, page, hint, data });
  const key = `explain:${hash(payload)}`;

  async function run(force = false) {
    setOpen(true);
    if (!force) {
      try {
        const saved = sessionStorage.getItem(key);
        if (saved) return setState({ loading: false, text: saved });
      } catch {}
    }
    setState({ loading: true });
    try {
      const res = await fetch("/api/advisor/explain", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      try {
        sessionStorage.setItem(key, json.text);
      } catch {}
      setState({ loading: false, text: json.text });
    } catch (e) {
      setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => run()}
        title="ให้ AI อธิบายความหมายของตัวเลขในส่วนนี้แบบเข้าใจง่าย"
        className={clsx(
          "inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/20",
          className,
        )}
      >
        <Sparkle /> {label}
      </button>
      {open && <ExplainDrawer topic={topic} state={state} onClose={() => setOpen(false)} onRetry={() => run(true)} />}
    </>
  );
}

function ExplainDrawer({
  topic,
  state,
  onClose,
  onRetry,
}: {
  topic: string;
  state: { loading: boolean; text?: string; error?: string };
  onClose: () => void;
  onRetry: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal aria-label={`คำอธิบาย: ${topic}`}>
      <button type="button" aria-label="ปิด" className="absolute inset-0 bg-[rgb(10_14_22/0.45)]" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-lg flex-col border-l border-border bg-panel-solid/85 shadow-2xl backdrop-blur-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-accent uppercase">
              <Sparkle /> AI อธิบายแบบเข้าใจง่าย
            </div>
            <h2 className="mt-0.5 font-semibold">{topic}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-muted hover:bg-panel-2 hover:text-text" aria-label="ปิด">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
          {state.loading && (
            <div className="space-y-3" aria-live="polite">
              <p className="text-muted">กำลังให้ AI อ่านตัวเลขและเรียบเรียงคำอธิบาย…</p>
              {[90, 75, 85, 60, 80].map((w, i) => (
                <div key={i} className="h-3 animate-pulse rounded bg-panel-2" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}
          {state.error && (
            <div className="space-y-3">
              <p className="rounded-lg border border-neg/40 bg-neg/10 p-3 text-neg">อธิบายไม่สำเร็จ: {state.error}</p>
              <button type="button" className="btn-ghost" onClick={onRetry}>
                ลองอีกครั้ง
              </button>
            </div>
          )}
          {state.text && (
            <div className="prose-note advisor-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.text}</ReactMarkdown>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-muted">
          <span>อธิบายจากตัวเลขบนหน้าจอเท่านั้น · ไม่ใช่คำแนะนำการลงทุน</span>
          <span className="flex shrink-0 gap-2">
            {state.text && (
              <button type="button" className="hover:text-text" onClick={onRetry}>
                อธิบายใหม่
              </button>
            )}
            <Link href="/advisor" className="text-accent hover:underline">
              ถามต่อ →
            </Link>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Card heading with an optional "อธิบาย" button on the right (for client components that build their own cards). */
export function CardTitle({ title, explain, className, children }: { title: string; explain?: ExplainSpec | null; className?: string; children?: React.ReactNode }) {
  return (
    <div className={clsx("mb-3 flex flex-wrap items-center justify-between gap-2", className)}>
      <h2 className="font-semibold">
        {title}
        {children}
      </h2>
      {explain && <ExplainButton topic={title} data={explain.data} hint={explain.hint} />}
    </div>
  );
}
