"use client";

import { useTransition } from "react";

export function ConfirmButton({ onConfirm, label = "ลบ", message = "ยืนยันการลบ?" }: { onConfirm: () => Promise<void>; label?: string; message?: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => confirm(message) && start(() => onConfirm())}
      className="text-xs text-text-muted hover:text-negative disabled:opacity-50"
    >
      {label}
    </button>
  );
}
