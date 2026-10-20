import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { AudiencePage } from "@/components/new-landing/sections/AudiencePage";
import { findAudience } from "@/components/new-landing/audiences";
import { getBrandTitle } from "@/utils/branding";

const audience = findAudience("real-estate")!;

export const metadata: Metadata = {
  title: getBrandTitle("Real Estate"),
  description:
    "OneMail for real estate: one client for every mailbox, with the rules, drafts and reminders that fit the work.",
  alternates: { canonical: "/real-estate" },
};

export default function RealEstatePage() {
  return (
    <BasicLayout>
      <AudiencePage audience={audience} />
    </BasicLayout>
  );
}
