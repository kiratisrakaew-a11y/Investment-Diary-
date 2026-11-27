/** Traffic-light status badge shared by the metrics panel and the per-metric chart cards. */
import clsx from "clsx";
import { STATUS_LABEL, type MetricStatus } from "@/lib/asset-metrics/thresholds";
import { StatusIcon, type Status } from "./icons";

const STATUS_STYLE: Record<MetricStatus, { cls: string; icon: Status | null; glyph: string }> = {
  GREEN: { cls: "border-positive/40 bg-positive/10 text-positive", icon: "green", glyph: "" },
  YELLOW: { cls: "border-warning/40 bg-warning/10 text-warning", icon: "yellow", glyph: "" },
  RED: { cls: "border-negative/40 bg-negative/10 text-negative", icon: "red", glyph: "" },
  NO_THRESHOLD: { cls: "border-border text-text-muted", icon: null, glyph: "○" },
  NO_DATA: { cls: "border-border text-text-muted", icon: null, glyph: "—" },
};

export function StatusBadge({ status, title }: { status: MetricStatus; title?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium whitespace-nowrap", s.cls)} title={title}>
      {s.icon ? <StatusIcon status={s.icon} /> : <span aria-hidden>{s.glyph}</span>}
      {STATUS_LABEL[status]}
    </span>
  );
}
