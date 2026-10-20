import type { Metadata } from "next";
import Link from "next/link";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { ErrorPage } from "@/components/ErrorPage";
import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/utils/branding";

export const metadata: Metadata = {
  title: `Update ${BRAND_NAME} Desktop`,
};

export default function DesktopUpdateRequiredPage() {
  return (
    <BasicLayout>
      <ErrorPage
        title="Update the desktop app to sign in"
        description={`This version of ${BRAND_NAME} Desktop can no longer complete sign-in. Download the latest version, reopen the app, and try signing in again.`}
        button={
          <Button asChild>
            <Link href="/download">Download the latest desktop app</Link>
          </Button>
        }
      />
    </BasicLayout>
  );
}
