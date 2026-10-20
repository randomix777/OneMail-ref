import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { AudiencePage } from "@/components/new-landing/sections/AudiencePage";
import { findAudience } from "@/components/new-landing/audiences";
import { getBrandTitle } from "@/utils/branding";

const audience = findAudience("small-business")!;

export const metadata: Metadata = {
  title: getBrandTitle("Small Business"),
  description:
    "OneMail for small business: one client for every mailbox, with the rules, drafts and reminders that fit the work.",
  alternates: { canonical: "/small-business" },
};

export default function SmallBusinessPage() {
  return (
    <BasicLayout>
      <AudiencePage audience={audience} />
    </BasicLayout>
  );
}
