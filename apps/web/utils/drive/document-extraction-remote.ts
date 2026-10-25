import { z } from "zod";
import { getCloudflareBindings } from "@/utils/cloudflare/context";
import type {
  ExtractionOptions,
  ExtractionResult,
} from "./document-extraction";

const resultSchema = z
  .object({
    text: z.string(),
    truncated: z.boolean(),
    pageCount: z.number().optional(),
  })
  .nullable();

export async function extractDocumentContents(
  buffer: Buffer,
  mimeType: string,
  { maxLength = 10_000, maxPages = 50 }: ExtractionOptions = {},
): Promise<ExtractionResult | null> {
  const documents = getCloudflareBindings()?.DOCUMENTS;
  if (!documents) throw new Error("Cloudflare DOCUMENTS binding is required");
  const url = new URL("https://documents.internal/extract");
  url.searchParams.set("maxLength", String(maxLength));
  url.searchParams.set("maxPages", String(maxPages));
  const response = await documents.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": mimeType },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(120_000),
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Document extraction returned ${response.status}`);
  }
  return resultSchema.parse(await response.json());
}
