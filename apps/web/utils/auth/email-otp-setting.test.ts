import { describe, expect, it } from "vitest";
import { updateEmailOtpSetting } from "@/utils/auth/email-otp-setting";

describe("email code access setting", () => {
  it("does not allow old clients to re-enable email-code sign-in", async () => {
    await expect(
      updateEmailOtpSetting({
        userId: "owner",
        sessionId: "session",
        enabled: true,
      }),
    ).rejects.toThrow("Email-code sign-in is no longer supported");
  });
});
