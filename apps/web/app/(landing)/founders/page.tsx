import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { AudiencePage } from "@/components/new-landing/sections/AudiencePage";
import { findAudience } from "@/components/new-landing/audiences";
import { getBrandTitle } from "@/utils/branding";

const audience = findAudience("founders")!;

export const metadata: Metadata = {
  title: getBrandTitle("Founders"),
  description:
    "OneMail for founders: one client for every mailbox, with the rules, drafts and reminders that fit the work.",
  alternates: { canonical: "/founders" },
};

export default function FoundersPage() {
  return (
    <BasicLayout>
      <AudiencePage audience={audience} />
    </BasicLayout>
  );
}
