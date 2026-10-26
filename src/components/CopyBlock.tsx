"use client";

import { useState } from "react";

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <div className="label">{label}</div>}
      <div className="relative">
        <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-bg p-3 pr-16 text-xs whitespace-pre-wrap">{text}</pre>
        <button
          type="button"
          className="btn-ghost absolute top-2 right-2 bg-panel text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "คัดลอกแล้ว" : "คัดลอก"}
        </button>
      </div>
    </div>
  );
}
