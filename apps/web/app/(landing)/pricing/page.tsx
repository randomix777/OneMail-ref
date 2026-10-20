import type { Metadata } from "next";
import { BasicLayout } from "@/components/layouts/BasicLayout";
import { GetStartedBand } from "@/components/new-landing/sections/GetStartedBand";
import { WhatItCosts } from "@/components/new-landing/sections/WhatItCosts";
import { getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Pricing"),
  description:
    "Free to self-host. You pay for your server and your model provider, nothing else.",
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
