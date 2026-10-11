const FALLBACK_LIFETIME = 10 * 60_000;

/** Decodes the JWT carried in the clx-authorization header (`access_token=<jwt>, ...`). */
export function decodeTokenPayload(clxAuthorization) {
  try {
    const match = /access_token=([^,\s]+)/.exec(clxAuthorization);
    if (!match) return null;
    const segment = match[1].split(".")[1];
    if (!segment) return null;
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Builds the stored auth state, like the CLI's auth.json: expiry from the JWT `exp` claim. */
export function authStateFromHeader(clxAuthorization, nowMs = Date.now()) {
  const payload = decodeTokenPayload(clxAuthorization);
  const expiresAt = typeof payload?.exp === "number" ? payload.exp * 1000 : nowMs + FALLBACK_LIFETIME;
  return { clxAuthorization, expiresAt };
}

export function personIdFromAuth(auth) {
  return decodeTokenPayload(auth.clxAuthorization)?.id_person ?? null;
}

export function isAuthValid(auth, nowMs = Date.now()) {
  return Boolean(auth?.clxAuthorization) && auth.expiresAt > nowMs;
}
