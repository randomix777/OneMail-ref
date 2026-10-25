import { getDocumentProxy } from "unpdf";
import * as mammoth from "mammoth";
import type { Logger } from "@/utils/logger";
import type {
  ExtractionOptions,
  ExtractionResult,
} from "./document-extraction";

export async function extractDocumentContents(
  buffer: Buffer,
  mimeType: string,
  { maxLength = 10_000, maxPages = 50, logger }: ExtractionOptions = {},
): Promise<ExtractionResult | null> {
  switch (mimeType) {
    case "application/pdf":
      return extractFromPdf(buffer, maxLength, maxPages, logger);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractFromDocx(buffer, maxLength, logger);
    case "text/plain":
      return extractFromPlainText(buffer, maxLength);
    default:
      logger?.info("Unsupported MIME type for extraction", { mimeType });
      return null;
  }
}

// ============================================================================
// PDF Extraction (using unpdf - serverless compatible)
// ============================================================================

async function extractFromPdf(
  buffer: Buffer,
  maxLength: number,
  maxPages: number,
  logger?: Logger,
): Promise<ExtractionResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));

  try {
    const pageCount = pdf.numPages;
    const pagesToProcess = Math.min(pageCount, maxPages);

    const textParts: string[] = [];
    let totalLength = 0;
    let truncated = false;

    for (let i = 1; i <= pagesToProcess && !truncated; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      // Extract text items and join them
      const pageText = (textContent.items as Array<{ str?: string }>)
        .map((item) => item.str ?? "")
        .join(" ");

      if (totalLength + pageText.length > maxLength) {
        // Truncate to fit within maxLength
        const remaining = maxLength - totalLength;
        textParts.push(pageText.slice(0, remaining));
        truncated = true;
      } else {
        textParts.push(pageText);
        totalLength += pageText.length;
      }
    }

    // Check if we hit page limit
    if (pagesToProcess < pageCount) {
      truncated = true;
    }

    const text = textParts.join("\n\n");

    logger?.info("PDF extraction complete", {
      pageCount,
      pagesProcessed: pagesToProcess,
      textLength: text.length,
      truncated,
    });

    return {
      text,
      pageCount,
      truncated,
    };
  } finally {
    await pdf.cleanup?.();
  }
}

// ============================================================================
// DOCX Extraction
// ============================================================================

async function extractFromDocx(
  buffer: Buffer,
  maxLength: number,
  logger?: Logger,
): Promise<ExtractionResult> {
  const result = await mammoth.extractRawText({
    buffer,
    arrayBuffer: new Uint8Array(buffer).buffer,
  });
  const text = result.value || "";
  const truncated = text.length > maxLength;

  logger?.info("DOCX extraction complete", {
    textLength: text.length,
    truncated,
    messageCount: result.messages?.length ?? 0,
  });

  return {
    text: truncated ? text.slice(0, maxLength) : text,
    truncated,
  };
}

// ============================================================================
// Plain Text Extraction
// ============================================================================

function extractFromPlainText(
  buffer: Buffer,
  maxLength: number,
): ExtractionResult {
  const text = buffer.toString("utf-8");
  const truncated = text.length > maxLength;

  return {
    text: truncated ? text.slice(0, maxLength) : text,
    truncated,
  };
}
