import { describe, expect, test } from "vitest";
import documentsWorker from "../../cloudflare/documents.worker";
import { cloudflareRequestScope } from "@/utils/cloudflare/context";
import { extractDocumentContents } from "./document-extraction-remote";

describe("Workers document extraction service", () => {
  test("preserves text extraction and truncation through the service binding", async () => {
    const result = await cloudflareRequestScope.run(
      { bindings: { DOCUMENTS: documentsWorker }, cleanup: new Set() },
      () =>
        extractDocumentContents(Buffer.from("Hello Workers"), "text/plain", {
          maxLength: 5,
        }),
    );
    expect(result).toEqual({ text: "Hello", truncated: true });
  });

  test("returns null for an unsupported document type", async () => {
    const result = await cloudflareRequestScope.run(
      { bindings: { DOCUMENTS: documentsWorker }, cleanup: new Set() },
      () => extractDocumentContents(Buffer.from("data"), "image/png"),
    );
    expect(result).toBeNull();
  });

  test("rejects extraction limits before parsing the document", async () => {
    const response = await documentsWorker.fetch(
      new Request("https://documents.internal/extract?maxPages=0", {
        method: "POST",
        body: "data",
      }),
    );
    expect(response.status).toBe(400);
  });

  test("fails explicitly when the binding is missing", async () => {
    await expect(
      extractDocumentContents(Buffer.from("data"), "text/plain"),
    ).rejects.toThrow("DOCUMENTS binding is required");
  });

  test("does not accept a failed service response as document text", async () => {
    await expect(
      cloudflareRequestScope.run(
        {
          bindings: {
            DOCUMENTS: {
              fetch: async () => new Response(null, { status: 503 }),
            },
          },
          cleanup: new Set(),
        },
        () => extractDocumentContents(Buffer.from("data"), "text/plain"),
      ),
    ).rejects.toThrow("Document extraction returned 503");
  });
});
