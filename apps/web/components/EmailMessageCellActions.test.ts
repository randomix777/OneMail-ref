import { describe, expect, it } from "vitest";
import { getEmailMessageCellActions } from "./EmailMessageCellActions";

describe("getEmailMessageCellActions", () => {
  it("shows Outlook actions and prefers the provider external URL", () => {
    expect(
      getEmailMessageCellActions({
        externalUrl:
          "https://outlook.office.com/mail/deeplink/read/outlook-message-1?ispopout=0",
        messageId: "outlook-message-1",
        provider: "microsoft",
        threadId: "outlook-thread-1",
        userEmail: "user@contoso.com",
      }),
    ).toEqual({
      openUrl:
        "https://outlook.office.com/mail/deeplink/read/outlook-message-1?ispopout=0",
      showViewEmailButton: true,
    });
  });

  it("does not use the generated fallback URL for Outlook", () => {
    expect(
      getEmailMessageCellActions({
        messageId: "outlook-message-1",
        provider: "microsoft",
        threadId: "outlook-thread-1",
        userEmail: "user@contoso.com",
      }),
    ).toEqual({
      openUrl: undefined,
      showViewEmailButton: true,
    });
  });

  it("falls back to the provider URL for Gmail", () => {
    expect(
      getEmailMessageCellActions({
        messageId: "message-1",
        provider: "google",
        threadId: "thread-1",
        userEmail: "user@gmail.com",
      }),
    ).toEqual({
      openUrl:
        "https://mail.google.com/mail/u/?authuser=user%40gmail.com#all/message-1",
      showViewEmailButton: true,
    });
  });

  it("hides actions when the email cell requests it", () => {
    expect(
      getEmailMessageCellActions({
        hideViewEmailButton: true,
        messageId: "message-1",
        provider: "google",
        threadId: "thread-1",
        userEmail: "user@gmail.com",
      }),
    ).toBeNull();
  });

  it("does not invent a link for a mailbox with no web URL we can build", () => {
    // The URL builder's fallback is Gmail's shape, so before this an IMAP message
    // got a mail.google.com link carrying its own id. Such a mailbox reads in the
    // app instead, which is why the button is still offered.
    expect(
      getEmailMessageCellActions({
        messageId: "INBOX:42",
        provider: "fastmail",
        threadId: "thread-1",
        userEmail: "ada@fastmail.com",
      }),
    ).toEqual({ openUrl: undefined, showViewEmailButton: true });
  });

  it("still prefers a provider link when the message carries one", () => {
    // Graph supplies `externalUrl`; a mailbox that hands us a real link needs no
    // generated fallback regardless of provider.
    expect(
      getEmailMessageCellActions({
        externalUrl: "https://app.fastmail.com/mail/Inbox/thread-1",
        messageId: "INBOX:42",
        provider: "fastmail",
        threadId: "thread-1",
        userEmail: "ada@fastmail.com",
      }),
    ).toEqual({
      openUrl: "https://app.fastmail.com/mail/Inbox/thread-1",
      showViewEmailButton: true,
    });
  });
});
