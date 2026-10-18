import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { sleep } from "@/utils/sleep";

const logger = createScopedLogger("nylas");

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

/** Nylas caps `limit` at 200 and lists 50 items by default. */
export const NYLAS_MAX_PAGE_SIZE = 200;

export function hasNylasConfig() {
  return Boolean(env.NYLAS_API_KEY && env.NYLAS_CLIENT_ID);
}

export class NylasApiError extends Error {
  readonly status: number;
  /** Parsed `Retry-After`, when the response carried one. */
  readonly retryAfterMs?: number;

  constructor({
    status,
    message,
    retryAfterMs,
  }: {
    status: number;
    message: string;
    retryAfterMs?: number;
  }) {
    super(message);
    this.name = "NylasApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isNylasErrorWithStatus(error: unknown, status: number) {
  return error instanceof NylasApiError && error.status === status;
}

type NylasRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Calls the Nylas v3 API.
 *
 * Every call is authenticated with our application API key. Nylas stores and
 * refreshes the user's provider tokens, so a grant id is the only thing we keep
 * per mailbox — there is no provider token for us to refresh here.
 *
 * Nylas does not retry throttled reads for us, so two classes are retried
 * deliberately: 429 (honouring `Retry-After` when present) and 5xx. Everything
 * else surfaces immediately.
 */
export async function nylasFetch<T>({
  path,
  method = "GET",
  query,
  body,
  signal,
  attempts = MAX_ATTEMPTS,
}: {
  path: string;
  method?: NylasRequestMethod;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  attempts?: number;
}): Promise<T> {
  const apiKey = env.NYLAS_API_KEY;
  if (!apiKey) {
    throw new NylasApiError({
      status: 401,
      message: "NYLAS_API_KEY is not configured",
    });
  }

  const url = buildUrl(path, query);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce<T>({ url, method, body, apiKey, signal });
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;

      const delayMs = retryDelayMs(error, attempt);
      logger.warn("Retrying Nylas request", {
        path,
        method,
        attempt,
        delayMs,
        status: error instanceof NylasApiError ? error.status : undefined,
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Fetches raw bytes — attachment downloads, which Nylas serves as the file
 * itself rather than a JSON envelope.
 */
export async function nylasFetchStream({
  path,
  query,
  signal,
  attempts = MAX_ATTEMPTS,
}: {
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  attempts?: number;
}): Promise<Response> {
  const apiKey = env.NYLAS_API_KEY;
  if (!apiKey) {
    throw new NylasApiError({
      status: 401,
      message: "NYLAS_API_KEY is not configured",
    });
  }

  const url = buildUrl(path, query);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        throw new NylasApiError({
          status: response.status,
          message: await describeFailure(response),
          retryAfterMs: parseRetryAfterHeader(
            response.headers.get("retry-after"),
          ),
        });
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;
      await sleep(retryDelayMs(error, attempt));
    }
  }

  throw lastError;
}

async function requestOnce<T>({
  url,
  method,
  body,
  apiKey,
  signal,
}: {
  url: string;
  method: NylasRequestMethod;
  body: unknown;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await fetch(url, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw new NylasApiError({
      status: response.status,
      message: await describeFailure(response),
      retryAfterMs: parseRetryAfterHeader(response.headers.get("retry-after")),
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `Nylas request failed with status ${response.status}`;

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; type?: string };
      request_id?: string;
    };
    const detail = parsed.error?.message ?? parsed.error?.type;
    return [
      `Nylas request failed with status ${response.status}`,
      detail,
      parsed.request_id ? `request_id ${parsed.request_id}` : undefined,
    ]
      .filter(Boolean)
      .join(": ");
  } catch {
    return `Nylas request failed with status ${response.status}`;
  }
}

function isRetryable(error: unknown) {
  if (!(error instanceof NylasApiError)) return false;
  return error.status === 429 || error.status >= 500;
}

function retryDelayMs(error: unknown, attempt: number) {
  const retryAfterMs = getRetryAfterMs(error);
  if (retryAfterMs !== undefined) return retryAfterMs;

  // Jitter keeps a burst of throttled grants from retrying in lockstep.
  const backoff = Math.min(
    BASE_BACKOFF_MS * 2 ** (attempt - 1),
    MAX_BACKOFF_MS,
  );
  return backoff + Math.floor(Math.random() * BASE_BACKOFF_MS);
}

function buildUrl(
  path: string,
  query: Record<string, string | number | boolean | undefined | null> = {},
) {
  const url = new URL(`${env.NYLAS_API_URI}/v3${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Nylas reports throttling as a 429 and asks callers to wait the number of
 * seconds in `Retry-After` when it is present. The header is either a delay in
 * seconds or an HTTP date. Both are best-effort: when neither is usable the
 * caller falls back to exponential backoff.
 */
function getRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof NylasApiError)) return;
  if (error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, MAX_BACKOFF_MS);
  }

  const fromMessage = error.message.match(/retry after (\d+(?:\.\d+)?)/i);
  if (fromMessage) {
    return Math.min(Number(fromMessage[1]) * 1000, MAX_BACKOFF_MS);
  }
  return;
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return;
  return Math.max(0, date - Date.now());
}
