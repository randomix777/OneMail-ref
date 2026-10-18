import { nylasFetch, NYLAS_MAX_PAGE_SIZE } from "@/utils/nylas/client";
import type {
  OutlookFolder,
  OutlookSystemFolder,
} from "@/utils/outlook/folders";

export type NylasFolder = {
  id: string;
  name?: string | null;
  attributes?: string[] | null;
  system_folder?: boolean | null;
  parent_id?: string | null;
  total_count?: number | null;
  unread_count?: number | null;
};

/**
 * Nylas reports RFC 9051 folder attributes, which are the portable way to find
 * a folder's purpose: names differ per provider ("Trash" can be "Deleted
 * Messages"), attributes do not.
 */
const ROLE_BY_ATTRIBUTE: Record<string, OutlookSystemFolder> = {
  "\\inbox": "INBOX",
  "\\sent": "SENT",
  "\\drafts": "DRAFT",
  "\\trash": "TRASH",
  "\\junk": "SPAM",
  "\\archive": "ARCHIVE",
};

/**
 * Google grants report Gmail's label ids as folder ids, and those name their own
 * role even when the attribute list is absent.
 */
const ROLE_BY_FOLDER_ID: Record<string, OutlookSystemFolder> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
};

const MAX_FOLDER_PAGES = 10;

export async function listNylasFolders(grantId: string) {
  const folders: NylasFolder[] = [];
  let pageToken: string | undefined;

  // Folders are few, but a flat list can still paginate; bound the walk so a
  // misbehaving cursor cannot spin forever.
  for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
    const response = await nylasFetch<{
      data?: NylasFolder[];
      next_cursor?: string | null;
    }>({
      path: `/grants/${grantId}/folders`,
      query: { limit: NYLAS_MAX_PAGE_SIZE, page_token: pageToken },
    });

    folders.push(...(response.data ?? []));

    if (!response.next_cursor) break;
    pageToken = response.next_cursor;
  }

  return folders;
}

export function roleOfFolder(
  folder: NylasFolder,
): OutlookSystemFolder | undefined {
  for (const attribute of folder.attributes ?? []) {
    const role = ROLE_BY_ATTRIBUTE[attribute.toLowerCase()];
    if (role) return role;
  }

  return ROLE_BY_FOLDER_ID[folder.id.toLowerCase()];
}

/**
 * Nylas flattens nested folders and reports the hierarchy through `parent_id`,
 * so the result is a flat list rather than a tree.
 */
export function toOutlookFolder(folder: NylasFolder): OutlookFolder {
  return {
    id: folder.id,
    displayName: folder.name ?? folder.id,
    childFolders: [],
    totalItemCount: folder.total_count ?? undefined,
    unreadItemCount: folder.unread_count ?? undefined,
    systemType: roleOfFolder(folder),
  };
}

export function findFolderIdByRole(
  folders: NylasFolder[],
  role: OutlookSystemFolder,
) {
  return folders.find((folder) => roleOfFolder(folder) === role)?.id;
}
