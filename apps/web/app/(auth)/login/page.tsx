import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; verified?: string }> }) {
  const params = await searchParams;
  return <LoginForm next={params.next ?? "/"} verified={params.verified === "1"} />;
}
