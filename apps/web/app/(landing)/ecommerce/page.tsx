import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { AudiencePage } from "@/components/new-landing/sections/AudiencePage";
import { findAudience } from "@/components/new-landing/audiences";
import { getBrandTitle } from "@/utils/branding";

const audience = findAudience("ecommerce")!;

export const metadata: Metadata = {
  title: getBrandTitle("E-commerce"),
  description:
    "OneMail for e-commerce: one client for every mailbox, with the rules, drafts and reminders that fit the work.",
  alternates: { canonical: "/ecommerce" },
};

export default function EcommercePage() {
  return (
    <BasicLayout>
      <AudiencePage audience={audience} />
    </BasicLayout>
  );
}
