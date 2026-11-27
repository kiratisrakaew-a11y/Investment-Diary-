/** spec-lookback-window: per-asset coverage of the chosen period (first price, periods, status). */
export function CoverageTable({
  rows,
}: {
  rows?: { symbol: string; firstDate: string | null; observations: number; status: "ok" | "limits_window" | "dropped"; reason?: string }[] | null;
}) {
  if (!rows?.length) return null;
  const label = { ok: "ใช้ได้", limits_window: "ทำให้ช่วงสั้นลง", dropped: "ไม่ได้ใช้" } as const;
  const tone = { ok: "text-positive", limits_window: "text-warning", dropped: "text-negative" } as const;
  return (
    <details className="text-xs" data-testid="coverage-panel" open={rows.some((r) => r.status !== "ok")}>
      <summary className="cursor-pointer text-text-muted">ข้อมูลรายสินทรัพย์ในช่วงนี้ ({rows.length} ตัว)</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="px-2 py-1">สินทรัพย์</th>
              <th className="px-2">ราคาวันแรก</th>
              <th className="px-2 text-right">งวดในช่วง</th>
              <th className="px-4">สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-t border-border">
                <td className="px-2 py-1 font-medium">{r.symbol}</td>
                <td className="px-2 tabular-nums">{r.firstDate ?? "—"}</td>
                <td className="px-2 text-right tabular-nums">{r.observations}</td>
                <td className={`px-4 ${tone[r.status]}`} title={r.reason}>
                  {label[r.status]}
                  {r.reason && r.status === "dropped" ? <span className="block text-text-muted">{r.reason}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
