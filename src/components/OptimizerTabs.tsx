"use client";

import { useState } from "react";
import clsx from "clsx";

/** Optimizer page tabs. Both panels stay mounted so settings and results survive a tab switch. */
export function OptimizerTabs({ optimizer, comparison, picker }: { optimizer: React.ReactNode; comparison: React.ReactNode; picker?: React.ReactNode }) {
  const [tab, setTab] = useState<"optimizer" | "comparison">("optimizer");
  const tabs = [
    { id: "optimizer", label: "จัดพอร์ต" },
    { id: "comparison", label: "เปรียบเทียบโมเดล" },
  ] as const;
  return (
    <div className="space-y-4">
      {picker}
      <div role="tablist" aria-label="เครื่องมือจัดพอร์ต" className="inline-flex rounded-xl border border-border p-0.5 text-sm">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} className={clsx("rounded-lg px-3 py-1.5", tab === t.id ? "bg-panel-2 font-medium text-text" : "text-muted hover:text-text")} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="panel-optimizer" aria-labelledby="tab-optimizer" hidden={tab !== "optimizer"} className="space-y-6">
        {optimizer}
      </div>
      <div role="tabpanel" id="panel-comparison" aria-labelledby="tab-comparison" hidden={tab !== "comparison"} className="min-w-0">
        {comparison}
      </div>
    </div>
  );
}
