import { redirect } from "next/navigation";

// v0: changelog deferred; redirect to the docs home for now.
export default function Page() {
  redirect("/docs");
}
