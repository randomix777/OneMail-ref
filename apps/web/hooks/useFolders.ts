import useSWR from "swr";
import type { GetFoldersResponse } from "@/app/api/user/folders/route";

/**
 * The folders a mailbox exposes.
 *
 * There is no family gate: Microsoft and Nylas report real folders, the IMAP
 * families report their mailboxes, and the direct Gmail client answers with an
 * empty list. Gating on "is this Outlook?" here is what kept Nylas-backed Google
 * mailboxes and the IMAP providers out of the folder views.
 */
export function useFolders() {
  const { data, error, isLoading, mutate } =
    useSWR<GetFoldersResponse>("/api/user/folders");
  return {
    folders: data || [],
    isLoading: !!isLoading,
    error,
    mutate,
  };
}
