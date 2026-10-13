import { parseCurl } from "../../../shared/curl.ts";
import { readPrivateJson, writePrivateJson } from "../../../shared/files.ts";
import { minutesLeft } from "../../../shared/jwt.ts";

/**
 * Publix signs in through Azure AD B2C with 2FA, so the session is imported
 * from the user's own browser ("Copy as cURL") instead of automating a login.
 * The purchase-history API wants two things: a Bearer access token (about an
 * hour of life) and the customer's EcmsId.
 */

export interface PublixSession {
  token: string;
  ecmsId: string;
  userAgent: string | null;
  savedAt: string;
}

const SESSION_FILE = "api-session.json";

function jsonCookie(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Either kind of copied request works: the purchase-history XHR (carries
 * Authorization + EcmsId headers) or any signed-in www.publix.com request
 * (carries the token in the AccessTokenJwt cookie and the EcmsId inside the
 * User cookie).
 */
export function sessionFromCurl(curlText: string, now: Date): PublixSession {
  const { headers, cookies } = parseCurl(curlText);
  let token = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  let ecmsId = (headers["ecmsid"] ?? "").trim();
  if (!token || !ecmsId) {
    token = token || (cookies["AccessTokenJwt"] ?? "").trim();
    ecmsId =
      ecmsId ||
      String(jsonCookie(cookies["User"]).EcmsId ?? "").trim() ||
      String(jsonCookie(cookies["CartMicroserviceInfo"]).UserID ?? "").trim();
  }
  if (!token || !ecmsId) {
    throw new Error(
      "No Publix credentials in that cURL. Sign in at publix.com, open Account > Purchases with DevTools' Network tab " +
        "open, and copy the request to services.publix.com/api/v1/PurchaseHistory as cURL."
    );
  }
  return { token, ecmsId, userAgent: headers["user-agent"] ?? null, savedAt: now.toISOString() };
}

export function saveSession(accountDir: string, session: PublixSession): void {
  writePrivateJson(accountDir, SESSION_FILE, session);
}

export function loadSession(accountDir: string): PublixSession | null {
  const session = readPrivateJson<PublixSession>(accountDir, SESSION_FILE);
  return session?.token && session.ecmsId ? session : null;
}

export function describeSession(session: PublixSession | null, now: Date): string {
  if (!session) return "no API session imported";
  const left = minutesLeft(session.token, now);
  if (left === null) return "API session imported (expiry unknown)";
  return left > 0 ? `API session valid for about ${left} more min` : `API session expired ${-left} min ago`;
}

export function requestHeaders(session: PublixSession): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${session.token}`,
    EcmsId: session.ecmsId,
    Origin: "https://www.publix.com",
    Referer: "https://www.publix.com/",
    ...(session.userAgent ? { "User-Agent": session.userAgent } : {}),
  };
}
