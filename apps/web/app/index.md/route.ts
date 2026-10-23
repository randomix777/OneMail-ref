import {
  getHomepageMarkdown,
  markdownResponse,
} from "@/utils/agent-markdown/content";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/utils/branding";

/**
 * The markdown representation of the landing page. Agent clients reach it at `/`
 * through the `Accept` rewrite in `next.config.ts`, and it is also a stable URL
 * of its own so a crawler can fetch it directly.
 */
export function GET(request: Request) {
  return markdownResponse(
    getHomepageMarkdown(new URL(request.url).origin, {
      brandName: BRAND_NAME,
      supportEmail: SUPPORT_EMAIL,
    }),
  );
}
