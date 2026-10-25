import { Buffer } from "node:buffer";
import { extractDocumentContents } from "../utils/drive/document-extraction-engine";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/extract") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const maxLength = Number(url.searchParams.get("maxLength") ?? 10_000);
    const maxPages = Number(url.searchParams.get("maxPages") ?? 50);
    if (
      !Number.isInteger(maxLength) ||
      maxLength < 1 ||
      maxLength > 1_000_000 ||
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 100
    ) {
      return new Response("Invalid extraction limits", { status: 400 });
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 26 * 1024 * 1024)
      return new Response("Document too large", { status: 413 });
    try {
      const result = await extractDocumentContents(
        Buffer.from(bytes),
        request.headers.get("content-type") ?? "",
        { maxLength, maxPages },
      );
      return Response.json(result);
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: this service has no application logger context
      console.error("Document extraction failed", error);
      return new Response("Document extraction failed", { status: 422 });
    }
  },
};
