import { NextResponse } from "next/server";
import { withEmailProvider } from "@/utils/middleware";
import type { EmailProvider } from "@/utils/email/types";

export type GetFoldersResponse = Awaited<ReturnType<typeof getFolders>>;

export const GET = withEmailProvider("user/folders", async (request) => {
  const emailProvider = request.emailProvider;

  // Each provider answers for itself: Microsoft and Nylas report real folders,
  // the IMAP families report their mailboxes, and the direct Gmail client has no
  // folders and returns an empty list. Gating on the family here used to exclude
  // everything except Microsoft, which also hid Nylas-backed Google mailboxes.
  const result = await getFolders({ emailProvider });
  return NextResponse.json(result);
});

async function getFolders({ emailProvider }: { emailProvider: EmailProvider }) {
  const folders = await emailProvider.getFolders();
  return folders;
}
