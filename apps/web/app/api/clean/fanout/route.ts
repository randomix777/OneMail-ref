import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";
import { assertCleanerApiEnabled } from "@/utils/cleaner-feature";
import { cleanFanoutSchema, fanOutCleanPage } from "@/utils/clean/fanout";

export const POST = withError(
  "clean/fanout",
  withQstashOrInternal(async (request) => {
    assertCleanerApiEnabled();
    const body = cleanFanoutSchema.parse(await request.json());
    await fanOutCleanPage(body, request.logger);
    return Response.json({ success: true });
  }),
);
