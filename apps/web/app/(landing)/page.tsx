import type { Metadata } from "next";
import { ClientShowcase, Hero } from "@/app/(landing)/home/Hero";
import { ClientCapabilities } from "@/components/new-landing/sections/ClientCapabilities";
import { GetStartedBand } from "@/components/new-landing/sections/GetStartedBand";
import { MailboxSupport } from "@/components/new-landing/sections/MailboxSupport";
import { WhatItCosts } from "@/components/new-landing/sections/WhatItCosts";
import { CallToAction } from "@/components/new-landing/CallToAction";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { FAQs } from "@/app/(landing)/home/FAQs";
import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function NewLanding() {
  // An instance that does not bill anyone has no prices to show. Every other
  // page is the same, because the product is the same either way.
  const showPricing = !env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS;

  return (
    <BasicLayout>
      <Hero
        title="One client for every mailbox you have"
        subtitle={`${BRAND_NAME} is a mail client that runs on your own infrastructure. It reads Gmail, Outlook, Yahoo, Fastmail, iCloud, Zoho and any IMAP server, keeps a local index of all of them, and puts them in one window. The assistant lives one click away when you want it.`}
        cta={<CallToAction showSalesButton={false} />}
        ctaNote="Free to run · macOS, Windows and the web"
      >
        <ClientShowcase />
      </Hero>
      <ClientCapabilities />
      <MailboxSupport />
      {showPricing ? <WhatItCosts /> : null}
      <GetStartedBand />
      {showPricing ? <FAQs /> : null}
    </BasicLayout>
  );
}
