/** `exp` of a JWT as a Date, without verifying it. Null when the token isn't a decodable JWT or carries no exp. */
export function jwtExpiry(token: string): Date | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** Minutes until expiry (negative once expired). Null when the expiry is unknown. */
export function minutesLeft(token: string, now: Date = new Date()): number | null {
  const exp = jwtExpiry(token);
  return exp ? Math.floor((exp.getTime() - now.getTime()) / 60000) : null;
}
