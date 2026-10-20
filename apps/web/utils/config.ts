export const AI_GENERATED_FIELD_VALUE = "___AI_GENERATE___";

export const EMAIL_ACCOUNT_HEADER = "X-Email-Account-ID";
export const EMAIL_ACCOUNT_ID_REQUIRED_ERROR = "Email account ID is required";

export const NO_REFRESH_TOKEN_ERROR_CODE = "NO_REFRESH_TOKEN";
export const MICROSOFT_AUTH_EXPIRED_ERROR_CODE = "MICROSOFT_AUTH_EXPIRED";

export const KNOWLEDGE_BASIC_MAX_ITEMS = 1;
export const KNOWLEDGE_BASIC_MAX_CHARS = 2000;

export const ConditionType = {
  AI: "AI",
  STATIC: "STATIC",
  LEARNED_PATTERN: "LEARNED_PATTERN",
  PRESET: "PRESET",
} as const;

export type ConditionType = (typeof ConditionType)[keyof typeof ConditionType];
export type CoreConditionType = Extract<ConditionType, "AI" | "STATIC">;

export const WELCOME_PATH = "/welcome-redirect";
export const MAIL_CLIENT_WELCOME_PATH = `${WELCOME_PATH}?mode=mail`;
export const MAIL_CLIENT_SIGNUP_PATH = `/login?next=${encodeURIComponent(MAIL_CLIENT_WELCOME_PATH)}`;

export const EXTENSION_URL = "https://go.jyisolutions.com/extension";

export const ONBOARDING_PROCESS_EMAILS_COUNT = 20;
