import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/utils/auth";
import { getBrandTitle } from "@/utils/branding";
import { WELCOME_PATH } from "@/utils/config";
import { normalizeInternalPath } from "@/utils/path";

export const metadata: Metadata = {
  title: getBrandTitle("Log in"),
};

export default async function EmailLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const callbackURL =
    normalizeInternalPath(
      typeof params.next === "string" ? params.next : undefined,
    ) ?? WELCOME_PATH;
  const session = await auth();
  if (session?.user) redirect(callbackURL);
  redirect(`/login?${new URLSearchParams({ next: callbackURL })}`);
}
