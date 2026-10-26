import { Nav } from "@/components/Nav";
import { logout } from "../login/actions";

export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav logout={logout} />
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6">{children}</main>
    </>
  );
}
