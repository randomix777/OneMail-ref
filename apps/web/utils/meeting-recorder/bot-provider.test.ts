import { describe, expect, it } from "vitest";
import {
  getMeetingBotDisplayName,
  MAX_MEETING_BOT_DISPLAY_NAME_LENGTH,
  MEETING_BOT_DISPLAY_NAME,
} from "@/utils/meeting-recorder/bot-provider";

describe("getMeetingBotDisplayName", () => {
  it("identifies the notetaker by the owner's first name", () => {
    expect(
      getMeetingBotDisplayName({
        ownerName: "Barbara Dalavecchia",
        ownerEmail: "barbara@example.com",
      }),
    ).toBe("Barbara's OneMail Notetaker");
  });

  it("uses the owner's email when their profile has no name", () => {
    expect(
      getMeetingBotDisplayName({
        ownerName: null,
        ownerEmail: "barbara@example.com",
      }),
    ).toBe("barbara@example.com's OneMail Notetaker");
  });

  it("stays within Recall's display-name limit", () => {
    const displayName = getMeetingBotDisplayName({
      ownerName: "B".repeat(101),
      ownerEmail: "barbara@example.com",
    });

    expect(displayName).toHaveLength(100);
    expect(displayName.endsWith("'s OneMail Notetaker")).toBe(true);
  });

  it("does not split an astral Unicode character at the display-name limit", () => {
    const suffix = `'s ${MEETING_BOT_DISPLAY_NAME}`;
    const maxOwnerIdentifierLength =
      MAX_MEETING_BOT_DISPLAY_NAME_LENGTH - suffix.length;
    const ownerName = `${"B".repeat(maxOwnerIdentifierLength - 1)}😀`;

    const displayName = getMeetingBotDisplayName({
      ownerName,
      ownerEmail: "barbara@example.com",
    });

    expect(displayName).toBe(
      `${"B".repeat(maxOwnerIdentifierLength - 1)}${suffix}`,
    );
    expect(displayName).toHaveLength(
      maxOwnerIdentifierLength - 1 + suffix.length,
    );
  });
});
