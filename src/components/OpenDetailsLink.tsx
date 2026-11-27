"use client";

/** Primary action that opens (and scrolls to) a <details id="…"> composer on the same page. */
export function OpenDetailsLink({ targetId, children }: { targetId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="btn"
      onClick={() => {
        const el = document.getElementById(targetId) as HTMLDetailsElement | null;
        if (!el) return;
        el.open = true;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.querySelector<HTMLElement>("input, textarea, select")?.focus();
      }}
    >
      {children}
    </button>
  );
}
