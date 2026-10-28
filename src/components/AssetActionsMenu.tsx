"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { assetDependenciesAction, assetLifecycleAction } from "@/app/(app)/actions";
import { dependencySummary, type AssetDependencies, type LifecycleAction } from "@/lib/asset-lifecycle";

interface Props {
  asset: { id: number; symbol: string };
  hidden: boolean;
  archived: boolean;
  held: boolean;
  /** Records referencing the asset (transactions, prices, valuations, …); all deleted with it. */
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
  const [deps, setDeps] = useState<AssetDependencies | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLDetailsElement>(null);

  const run = (action: LifecycleAction, confirmSymbol?: string) =>
    start(async () => {
      const r = await assetLifecycleAction(asset.id, action, confirmSymbol, action === "delete");
      const ok = r.status !== "FORBIDDEN" && r.status !== "BLOCKED_HAS_DEPENDENCIES" && r.status !== "NOT_FOUND";
      setMsg({ ok, text: r.message });
      if (ok) {
        dialog.current?.close();
        details.current?.removeAttribute("open");
        // The asset page no longer exists after a delete: go back to the holdings list.
        if (action === "delete" && variant === "page") router.push("/holdings");
        else router.refresh();
      }
    });

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
        className="menu-item text-neg"
        disabled={pending}
        title={dependencyCount > 0 ? `ลบพร้อมข้อมูลที่เกี่ยวข้อง ${dependencyCount} รายการ` : undefined}
        onClick={() => {
          setConfirm("");
          setMsg(null);
          setDeps(null);
          dialog.current?.showModal();
          start(async () => setDeps(await assetDependenciesAction(asset.id)));
        }}
      >
        ลบถาวร
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
        <p className="mt-2 text-xs text-muted">ลบสินทรัพย์นี้และข้อมูลทั้งหมดที่ผูกกับมัน — กู้คืนไม่ได้ บันทึก (notes) ยังอยู่แต่จะไม่ผูกกับสินทรัพย์นี้แล้ว</p>
        <div className="mt-2 rounded-lg border border-neg/40 bg-neg/5 p-2 text-xs" aria-live="polite">
          {!deps ? (
            <span className="text-muted">กำลังนับข้อมูลที่จะถูกลบ…</span>
          ) : dependencySummary({ ...deps, notes: 0 }).total || deps.notes ? (
            <>
              {dependencySummary({ ...deps, notes: 0 }).total > 0 && (
                <>
                  <div className="font-medium text-neg">จะถูกลบไปด้วย:</div>
                  <div className="mt-0.5">{dependencySummary({ ...deps, notes: 0 }).text}</div>
                </>
              )}
              {deps.notes > 0 && <div className="mt-1 text-muted">บันทึก {deps.notes} รายการ: เก็บไว้ แต่ตัดการผูกกับ {asset.symbol}</div>}
              {held && <div className="mt-1 text-neg">ยังถืออยู่ — ยอดในพอร์ตและผลตอบแทนย้อนหลังจะเปลี่ยน</div>}
            </>
          ) : (
            <span className="text-muted">ไม่มีข้อมูลอื่นผูกอยู่</span>
          )}
        </div>
        {!held && <p className="mt-2 text-[11px] text-muted">ถ้าแค่ต้องการเอาออกจากหน้าจอ ใช้ “ซ่อน” หรือ “เก็บถาวร” แทน (ข้อมูลยังอยู่ครบ)</p>}
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
            disabled={pending || !deps || confirm.trim().toUpperCase() !== asset.symbol.toUpperCase()}
            onClick={() => run("delete", confirm)}
          >
            {pending ? "กำลังลบ…" : "ลบถาวร"}
          </button>
        </div>
      </dialog>
    </>
  );
}
