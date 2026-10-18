import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findFolderIdByRole,
  listNylasFolders,
  roleOfFolder,
  toOutlookFolder,
  type NylasFolder,
} from "@/utils/nylas/folder";

const { nylasEnv } = vi.hoisted(() => ({
  nylasEnv: {
    NYLAS_API_KEY: "nylas-api-key" as string | undefined,
    NYLAS_API_URI: "https://api.us.nylas.com",
  },
}));

vi.mock("@/env", () => ({ env: nylasEnv }));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("roleOfFolder", () => {
  it("reads the RFC 9051 attribute a provider reports", () => {
    expect(roleOfFolder({ id: "folder-9", attributes: ["\\Trash"] })).toBe(
      "TRASH",
    );
    expect(roleOfFolder({ id: "folder-9", attributes: ["\\Junk"] })).toBe(
      "SPAM",
    );
    expect(roleOfFolder({ id: "folder-9", attributes: ["\\Drafts"] })).toBe(
      "DRAFT",
    );
  });

  it("matches attributes without regard to case", () => {
    expect(roleOfFolder({ id: "x", attributes: ["\\INBOX"] })).toBe("INBOX");
  });

  it("falls back to the Gmail label id Google grants report", () => {
    expect(roleOfFolder({ id: "SENT" })).toBe("SENT");
    expect(roleOfFolder({ id: "inbox" })).toBe("INBOX");
  });

  it("prefers the attribute when the two disagree", () => {
    // A provider is free to name a folder INBOX; the attribute is the authority.
    expect(roleOfFolder({ id: "INBOX", attributes: ["\\Archive"] })).toBe(
      "ARCHIVE",
    );
  });

  it("reports no role for a user-created folder", () => {
    expect(roleOfFolder({ id: "Label_2", name: "Receipts" })).toBeUndefined();
  });
});

describe("toOutlookFolder", () => {
  it("names and counts a folder the way the rest of the app expects", () => {
    expect(
      toOutlookFolder({
        id: "folder-1",
        name: "Accounting",
        total_count: 12,
        unread_count: 3,
      }),
    ).toEqual({
      id: "folder-1",
      displayName: "Accounting",
      childFolders: [],
      totalItemCount: 12,
      unreadItemCount: 3,
      systemType: undefined,
    });
  });

  it("falls back to the id when a folder has no name", () => {
    expect(toOutlookFolder({ id: "folder-1" }).displayName).toBe("folder-1");
  });

  it("leaves counts undefined rather than reporting zero", () => {
    const folder = toOutlookFolder({ id: "folder-1" });

    expect(folder.totalItemCount).toBeUndefined();
    expect(folder.unreadItemCount).toBeUndefined();
  });
});

describe("findFolderIdByRole", () => {
  it("resolves the folder a role lives in", () => {
    const folders: NylasFolder[] = [
      { id: "Label_2", name: "Receipts" },
      { id: "SENT", attributes: ["\\Sent"] },
    ];

    expect(findFolderIdByRole(folders, "SENT")).toBe("SENT");
    expect(findFolderIdByRole(folders, "TRASH")).toBeUndefined();
  });
});

describe("listNylasFolders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nylasEnv.NYLAS_API_KEY = "nylas-api-key";
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns one page when the response reports no cursor", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: "INBOX", attributes: ["\\Inbox"] }] }),
    );

    await expect(listNylasFolders("grant-1")).resolves.toEqual([
      { id: "INBOX", attributes: ["\\Inbox"] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows the cursor to collect every page", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "INBOX" }], next_cursor: "cursor-2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "SENT" }] }));

    await expect(listNylasFolders("grant-1")).resolves.toEqual([
      { id: "INBOX" },
      { id: "SENT" },
    ]);

    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain("page_token=cursor-2");
  });

  it("stops instead of spinning when a cursor never runs out", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ data: [{ id: "INBOX" }], next_cursor: "same" }),
      ),
    );

    await listNylasFolders("grant-1");

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("tolerates a response with no folders", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(listNylasFolders("grant-1")).resolves.toEqual([]);
  });
});
