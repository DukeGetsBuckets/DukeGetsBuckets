import { redirect } from "next/navigation";

export default function QuickPlayPage() {
  redirect("/play?quick=1");
}
