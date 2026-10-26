"use client";

import { useActionState } from "react";
import { updatePricesAction } from "@/app/(app)/actions";

export function UpdatePricesButton() {
  const [state, action, pending] = useActionState(updatePricesAction, null);
  return (
    <form action={action} className="flex items-center gap-2">
      <button className="btn-ghost" disabled={pending}>{pending ? "กำลังดึงราคา…" : "↻ ดึงราคาล่าสุด"}</button>
      {state?.error && <span className="max-w-md text-xs text-neg">{state.error}</span>}
      {state?.ok && <span className="text-xs text-pos">{state.message}</span>}
    </form>
  );
}
