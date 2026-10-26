"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, createSessionToken, safeEqual, sessionCookieOptions } from "@/lib/auth";

export async function login(form: FormData) {
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");
  const expected = process.env.APP_PASSWORD;
  if (!expected || !safeEqual(password, expected)) redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  (await cookies()).set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions);
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
