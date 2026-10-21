import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/utils/auth";
import { getBrandTitle } from "@/utils/branding";
import { WELCOME_PATH } from "@/utils/config";
import { normalizeInternalPath } from "@/utils/path";

export const metadata: Metadata = {
  title: getBrandTitle("Log in"),
};

export default async function LoginOptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextPath = normalizeInternalPath(
    typeof params.next === "string" ? params.next : undefined,
  );
  const session = await auth();
  if (session?.user) redirect(nextPath ?? WELCOME_PATH);
  redirect(
    nextPath ? `/login?${new URLSearchParams({ next: nextPath })}` : "/login",
  );
}
