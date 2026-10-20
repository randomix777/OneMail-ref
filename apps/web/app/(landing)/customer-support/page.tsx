import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { AudiencePage } from "@/components/new-landing/sections/AudiencePage";
import { findAudience } from "@/components/new-landing/audiences";
import { getBrandTitle } from "@/utils/branding";

const audience = findAudience("customer-support")!;

export const metadata: Metadata = {
  title: getBrandTitle("Customer Support"),
  description:
    "OneMail for customer support: one client for every mailbox, with the rules, drafts and reminders that fit the work.",
  alternates: { canonical: "/customer-support" },
};

export default function CustomerSupportPage() {
  return (
    <BasicLayout>
      <AudiencePage audience={audience} />
    </BasicLayout>
  );
}
