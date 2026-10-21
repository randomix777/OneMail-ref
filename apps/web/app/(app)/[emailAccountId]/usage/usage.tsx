"use client";

import { BotIcon, CpuIcon } from "lucide-react";
import { formatStat } from "@/utils/stats";
import { StatsCards } from "@/components/StatsCards";
import { usePremium } from "@/hooks/usePremium";
import { LoadingContent } from "@/components/LoadingContent";
import type { RedisUsage } from "@/utils/redis/usage";

export function Usage(props: { usage: RedisUsage | null }) {
  const { isLoading, error } = usePremium();

  return (
    <LoadingContent loading={isLoading} error={error}>
      <StatsCards
        stats={[
          {
            name: "LLM API Calls",
            value: formatStat(props.usage?.calls),
            subvalue: "calls",
            icon: <BotIcon className="h-4 w-4" />,
          },
          {
            name: "LLM Tokens Used",
            value: formatStat(props.usage?.tokensUsed),
            subvalue: "tokens",
            icon: <CpuIcon className="h-4 w-4" />,
          },
        ]}
      />
    </LoadingContent>
  );
}
