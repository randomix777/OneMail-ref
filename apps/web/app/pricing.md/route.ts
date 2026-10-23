import {
  getPricingMarkdown,
  markdownResponse,
} from "@/utils/agent-markdown/content";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/utils/branding";

/**
 * The markdown representation of the pricing page, reachable at `/pricing`
 * through the `Accept` rewrite in `next.config.ts`.
 */
export function GET(request: Request) {
  return markdownResponse(
    getPricingMarkdown(new URL(request.url).origin, {
      brandName: BRAND_NAME,
      supportEmail: SUPPORT_EMAIL,
    }),
  );
}
