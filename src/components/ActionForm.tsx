"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ActionState } from "@/app/(app)/actions";

/** <form> bound to a server action that reports success / error inline. */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = true,
  submitLabel = "บันทึก",
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      <div className="flex items-center gap-3 pt-1">
        <button className="btn" disabled={pending}>
          {pending ? "กำลังบันทึก…" : submitLabel}
        </button>
        {state?.error && <span className="text-sm text-neg">{state.error}</span>}
        {state?.ok && state.message && <span className="text-sm text-pos">{state.message}</span>}
      </div>
    </form>
  );
}
