import { currentPrincipal } from "@/server/auth";
import { SignedInBar } from "../SignedInBar";

// Every procurement page is signed-in only (each page checks again); this shows who is signed in and offers sign-out.
export default async function ProcurementsLayout({ children }: { children: React.ReactNode }) {
  const me = await currentPrincipal();
  return (
    <>
      {me ? <SignedInBar name={me.displayName} role={me.kind} /> : null}
      {children}
    </>
  );
}
