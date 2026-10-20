import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { GetStartedBand } from "@/components/new-landing/sections/GetStartedBand";
import { WhatItCosts } from "@/components/new-landing/sections/WhatItCosts";
import { getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Pricing"),
  description:
    "The client is free. Google mail, at $4.99 CAD per mailbox, and the tokens the assistant uses are the two things that cost money.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <BasicLayout>
      <WhatItCosts />
      <GetStartedBand />
    </BasicLayout>
  );
}
