import { describe, expect, it } from "vitest";
import { parseImapMessageId, toImapMessageId } from "@/utils/imap/provider";

describe("IMAP message ids", () => {
  it("round-trips a mailbox and uid", () => {
    const id = toImapMessageId(42, "INBOX");

    expect(id).toBe("INBOX:42");
    expect(parseImapMessageId(id)).toEqual({ folderId: "INBOX", uid: 42 });
  });

  it("keeps a mailbox name that contains the separator", () => {
    // The separator is the last colon, so a dotted or colon-bearing folder path
    // still parses back to itself.
    const id = toImapMessageId(7, "Archive:2024");

    expect(parseImapMessageId(id)).toEqual({
      folderId: "Archive:2024",
      uid: 7,
    });
  });

  it("reads a bare number as an inbox message", () => {
    expect(parseImapMessageId("42")).toEqual({ folderId: "INBOX", uid: 42 });
  });

  it("rejects an id it cannot turn into a uid", () => {
    // A mutation that guessed at the id would act on an unrelated message, so
    // these fail loudly instead.
    expect(() => parseImapMessageId("INBOX:not-a-number")).toThrow(/Invalid/);
    expect(() => parseImapMessageId("INBOX:0")).toThrow(/Invalid/);
    expect(() => parseImapMessageId("-3")).toThrow(/Invalid/);
    expect(() => parseImapMessageId("")).toThrow(/Invalid/);
  });
});
