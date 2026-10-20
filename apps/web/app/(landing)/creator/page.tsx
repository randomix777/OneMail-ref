import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { AudiencePage } from "@/components/new-landing/sections/AudiencePage";
import { findAudience } from "@/components/new-landing/audiences";
import { getBrandTitle } from "@/utils/branding";

const audience = findAudience("creator")!;

export const metadata: Metadata = {
  title: getBrandTitle("Content Creators"),
  description:
    "OneMail for content creators: one client for every mailbox, with the rules, drafts and reminders that fit the work.",
  alternates: { canonical: "/creator" },
};

export default function CreatorPage() {
  return (
    <BasicLayout>
      <AudiencePage audience={audience} />
    </BasicLayout>
  );
}
