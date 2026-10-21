import { SafeError } from "@/utils/error";

export async function updateEmailOtpSetting(_input: {
  userId: string;
  sessionId: string | undefined;
  enabled: boolean;
}) {
  throw new SafeError(
    "Email-code sign-in is no longer supported. Sign in through your JYI account.",
  );
}
