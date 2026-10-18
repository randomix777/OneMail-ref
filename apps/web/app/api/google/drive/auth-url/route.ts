import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import {
  getGoogleDriveOAuth2Url,
  type GoogleDriveAccessLevel,
} from "@/utils/drive/client";
import { isDriveFilingAvailable } from "@/utils/drive/availability";
import { DRIVE_STATE_COOKIE_NAME } from "@/utils/drive/constants";
import {
  generateSignedOAuthState,
  oauthStateCookieOptions,
} from "@/utils/oauth/state";

export type GetDriveAuthUrlResponse = { url: string };

export const GET = withEmailAccount(
  "google/drive/auth-url",
  async (request) => {
    const { emailAccountId } = request.auth;

    // Refused here rather than at the callback: this is the moment our client
    // would ask Google for Drive access, and the whole point of carrying mail
    // through Nylas is not to ask for it.
    if (!(await isDriveFilingAvailable(emailAccountId))) {
      return NextResponse.json(
        {
          error:
            "Filing to Google Drive is not available for this account, because its mail is reached through Nylas. OneDrive filing is unaffected.",
          isKnownError: true,
        },
        { status: 400 },
      );
    }

    const { searchParams } = new URL(request.url);
    const accessLevel = getAccessLevel(searchParams);
    const { url, state } = getAuthUrl({ emailAccountId, accessLevel });

    const res: GetDriveAuthUrlResponse = { url };
    const response = NextResponse.json(res);

    response.cookies.set(
      DRIVE_STATE_COOKIE_NAME,
      state,
      oauthStateCookieOptions,
    );

    return response;
  },
);

const getAuthUrl = ({
  emailAccountId,
  accessLevel,
}: {
  emailAccountId: string;
  accessLevel: GoogleDriveAccessLevel;
}) => {
  const state = generateSignedOAuthState({
    emailAccountId,
    type: "drive",
  });

  const url = getGoogleDriveOAuth2Url(state, accessLevel);

  return { url, state };
};

function getAccessLevel(params: URLSearchParams): GoogleDriveAccessLevel {
  return params.get("access") === "full" ? "full" : "limited";
}
