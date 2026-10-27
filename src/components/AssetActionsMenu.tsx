"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { assetLifecycleAction } from "@/app/(app)/actions";
import type { LifecycleAction } from "@/lib/asset-lifecycle";

interface Props {
  asset: { id: number; symbol: string };
  hidden: boolean;
  archived: boolean;
  held: boolean;
  /** Records referencing the asset (transactions, prices, valuations, …); delete only when 0. */
  dependencyCount: number;
  /** chip = compact ⋯ menu; page = inline buttons on the asset page. */
  variant?: "chip" | "page";
}

/**
 * Hide / archive / restore / permanent delete for one asset (by id). Every action goes to the server,
 * which re-checks the rules inside a transaction; the server's typed result is what is shown.
 */
export function AssetActionsMenu({ asset, hidden, archived, held, dependencyCount, variant = "chip" }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLDetailsElement>(null);

  const run = (action: LifecycleAction, confirmSymbol?: string) =>
    start(async () => {
      const r = await assetLifecycleAction(asset.id, action, confirmSymbol);
      const ok = r.status !== "FORBIDDEN" && r.status !== "BLOCKED_HAS_DEPENDENCIES" && r.status !== "NOT_FOUND";
      setMsg({ ok, text: r.message });
      if (ok) {
        dialog.current?.close();
        details.current?.removeAttribute("open");
        router.refresh();
      }
    });

  const deleteReason = held ? "ยังถืออยู่" : dependencyCount > 0 ? `มีข้อมูลอ้างถึง ${dependencyCount} รายการ — ใช้ซ่อน/เก็บถาวรแทน` : null;
  const items = (
    <>
      {variant === "chip" && (
        <Link href={`/holdings/${asset.id}`} role="menuitem" className="menu-item">
          ดูรายละเอียด
        </Link>
      )}
      {!held && (
        <button type="button" role="menuitem" className="menu-item" disabled={pending} onClick={() => run(hidden ? "unhide" : "hide")}>
          {hidden ? "แสดงในหน้าสินทรัพย์" : "ซ่อนจากหน้าสินทรัพย์"}
        </button>
      )}
      {!held && (
        <button type="button" role="menuitem" className="menu-item" disabled={pending} onClick={() => run(archived ? "unarchive" : "archive")}>
          {archived ? "นำกลับมาใช้งาน" : "เก็บถาวร (archive)"}
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={clsx("menu-item", !deleteReason && "text-neg")}
        disabled={pending || !!deleteReason}
        title={deleteReason ?? undefined}
        onClick={() => {
          setConfirm("");
          setMsg(null);
          dialog.current?.showModal();
        }}
      >
        ลบถาวร{deleteReason ? ` — ${deleteReason}` : ""}
      </button>
    </>
  );

  return (
    <>
      {variant === "chip" ? (
        <details ref={details} className="relative">
          <summary aria-label={`จัดการ ${asset.symbol}`} className="cursor-pointer list-none rounded-md px-1.5 text-muted hover:bg-panel-2 hover:text-text [&::-webkit-details-marker]:hidden">
            ⋯
          </summary>
          <div role="menu" className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-border bg-panel-solid p-1 shadow-lg">
            {items}
          </div>
        </details>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs [&_.menu-item]:btn-ghost [&_.menu-item]:py-1 [&_.menu-item]:text-xs">{items}</div>
      )}
      {msg && (
        <span role="status" className={clsx("text-[11px]", msg.ok ? "text-pos" : "text-neg", variant === "chip" && "absolute top-full left-0 z-30 mt-1 w-64 rounded-lg border border-border bg-panel-solid p-2")}>
          {msg.text}
        </span>
      )}
      <dialog ref={dialog} aria-labelledby={`del-${asset.id}`} className="m-auto w-[min(26rem,92vw)] rounded-2xl border border-border bg-panel-solid p-5 text-text backdrop:bg-black/50">
        <h2 id={`del-${asset.id}`} className="text-[15px] font-semibold text-neg">
          ลบ {asset.symbol} ถาวร
        </h2>
        <p className="mt-2 text-xs text-muted">
          ลบได้เฉพาะสินทรัพย์ที่ไม่มีรายการ ราคา valuation งบ ปันผล หรือบันทึกอ้างถึง — ระบบตรวจซ้ำอีกครั้งตอนลบ และไม่ลบข้อมูลอื่นให้ ถ้าต้องการแค่เอาออกจากหน้าจอ ให้ใช้ “ซ่อน” หรือ “เก็บถาวร”
        </p>
        <label className="mt-3 block">
          <span className="label">พิมพ์ {asset.symbol} เพื่อยืนยัน</span>
          <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </label>
        {msg && !msg.ok && <p className="mt-2 text-xs text-neg">{msg.text}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => dialog.current?.close()}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="inline-flex items-center rounded-lg bg-neg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            disabled={pending || confirm.trim().toUpperCase() !== asset.symbol.toUpperCase()}
            onClick={() => run("delete", confirm)}
          >
            {pending ? "กำลังลบ…" : "ลบถาวร"}
          </button>
        </div>
      </dialog>
    </>
  );
}
