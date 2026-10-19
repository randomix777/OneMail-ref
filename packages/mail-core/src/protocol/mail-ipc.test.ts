import { describe, expect, it } from "vitest";
import { MAIL_IPC_PROTOCOL_VERSION, mailIpcRequestSchema } from "./mail-ipc";

/**
 * The families the product actually connects, written out rather than read from
 * `providerSchema.options`: deriving the list from the enum under test would let
 * a narrowed enum narrow the test with it, which is exactly the regression this
 * is meant to catch.
 */
const CONNECTED_FAMILIES = [
  "google",
  "microsoft",
  "yahoo",
  "zoho",
  "fastmail",
  "icloud",
  "imap",
] as const;

/**
 * The IPC envelope is where a family the engine does not know about would be
 * rejected before any work happened, so these pin the widest part of the
 * protocol: the set of families it will carry at all.
 */
describe("mail IPC request schema", () => {
  it("accepts a sync request for every family the product connects", () => {
    for (const provider of CONNECTED_FAMILIES) {
      const parsed = mailIpcRequestSchema.safeParse({
        protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "requestSync",
        payload: { accountIds: ["acc-1"], provider },
      });

      // A family missing from this payload's enum cannot ask for a sync at all,
      // which is how an IMAP mailbox would have failed before the enum widened.
      expect(parsed.success, provider).toBe(true);
    }
  });

  it("still rejects a family the protocol does not declare", () => {
    const parsed = mailIpcRequestSchema.safeParse({
      protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      method: "requestSync",
      payload: { accountIds: ["acc-1"], provider: "carrier-pigeon" },
    });

    expect(parsed.success).toBe(false);
  });

  it("requires at least one account to sync", () => {
    const parsed = mailIpcRequestSchema.safeParse({
      protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      method: "requestSync",
      payload: { accountIds: [] },
    });

    expect(parsed.success).toBe(false);
  });
});
