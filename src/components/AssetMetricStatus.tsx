/** Traffic-light status badge shared by the metrics panel and the per-metric chart cards. */
import clsx from "clsx";
import { STATUS_LABEL, type MetricStatus } from "@/lib/asset-metrics/thresholds";

const STATUS_STYLE: Record<MetricStatus, { text: string; icon: string }> = {
  GREEN: { text: "text-pos", icon: "●" },
  YELLOW: { text: "text-warn", icon: "▲" },
  RED: { text: "text-neg", icon: "■" },
  NO_THRESHOLD: { text: "text-muted", icon: "○" },
  NO_DATA: { text: "text-muted", icon: "–" },
};

export function StatusBadge({ status, title }: { status: MetricStatus; title?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px]", s.text)} title={title}>
      <span aria-hidden>{s.icon}</span>
      {STATUS_LABEL[status]}
    </span>
  );
}
