// Common Google OAuth plumbing. Calendar and Classroom use different scopes,
// connection rows, callbacks and one-time state purposes. Tokens never leave D1.

import { CalendarInputError, type Fetcher } from "./calendar";
import type { GoogleOAuthRow, OAuthPurpose, Store } from "./store";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Overrides `${worker origin}/v1/google/callback`. */
  redirectUri?: string;
  /** Overrides `${worker origin}/v1/classroom/callback` independently. */
  classroomRedirectUri?: string;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_TIMEOUT_MS = 15_000;
const STATE_TTL_MS = 10 * 60_000;

/** HTTPS app return address, or local HTTP for development; no credentials. */
export function normalizeReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) return null;
  return u.origin + u.pathname;
}

function randomState(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startGoogleOAuth(
  store: Store,
  cfg: GoogleConfig,
  redirectUri: string,
  rawReturnUrl: unknown,
  now: number,
  purpose: OAuthPurpose,
  scopes: readonly string[],
): Promise<string> {
  const returnUrl = normalizeReturnUrl(rawReturnUrl);
  if (!returnUrl) throw new CalendarInputError("Pocketed's address couldn't be used to come back to.");
  const state = randomState();
  await store.putOAuthState(state, returnUrl, now + STATE_TTL_MS, now, purpose);
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    // Adding another account must always open the Google account chooser.
    prompt: "select_account consent",
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH_URL}?${q}`;
}

export function backToGoogleApp(returnUrl: string, purpose: OAuthPurpose, error?: string, accountId?: string): Response {
  const marker = purpose === "calendar" ? "google" : "classroom";
  const location = error
    ? `${returnUrl}#${marker}=error&message=${encodeURIComponent(error)}`
    : `${returnUrl}#${marker}=connected${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`;
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function expiredPage(): Response {
  const html =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Pocketed</title><body style="font-family:system-ui;padding:2rem;max-width:32rem">` +
    `<h1 style="font-size:1.2rem">Pocketed</h1><p>This sign-in link has expired or was already used. ` +
    `Go back to Pocketed and connect Google again.</p></body>`;
  return new Response(html, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export interface GoogleTokens {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

export async function googlePostForm(fetcher: Fetcher, url: string, form: Record<string, string>) {
  return fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
}

export async function googleReadJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Exchange a code only after consuming state for the intended integration. */
export async function finishGoogleOAuth(
  store: Store,
  cfg: GoogleConfig,
  redirectUri: string,
  params: URLSearchParams,
  now: number,
  fetcher: Fetcher,
  purpose: OAuthPurpose,
  /** Each group is a required permission; any spelling in that group is allowed. */
  requiredScopes: readonly (readonly string[])[],
  permissionMessage: string,
): Promise<{ returnUrl: string; tokens: GoogleTokens & { access_token: string; refresh_token: string } } | Response> {
  const state = params.get("state") ?? "";
  const returnUrl = state ? await store.takeOAuthState(state, now, purpose) : null;
  if (!returnUrl) return expiredPage();
  const back = (message: string) => backToGoogleApp(returnUrl, purpose, message);
  if (params.get("error")) {
    return back(params.get("error") === "access_denied"
      ? "Google sign-in was cancelled." + (purpose === "classroom" ? " Your school may need to approve Pocketed if access is blocked." : "")
      : `Google sign-in failed (${params.get("error")}).`);
  }
  const code = params.get("code");
  if (!code) return back("Google didn't send a sign-in code. Try again.");
  let tok: GoogleTokens | null;
  try {
    const res = await googlePostForm(fetcher, TOKEN_URL, {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    tok = await googleReadJson<GoogleTokens>(res);
    if (!res.ok) tok = { error: tok?.error ?? `HTTP ${res.status}` };
  } catch {
    return back("Couldn't reach Google. Try again in a minute.");
  }
  if (!tok || tok.error || typeof tok.access_token !== "string" || !tok.access_token) {
    return back(`Google didn't accept the sign-in (${tok?.error ?? "no token"}). Check the server's Google settings.`);
  }
  const scopes = typeof tok.scope === "string" ? tok.scope.split(/\s+/) : [];
  if (!requiredScopes.every((group) => group.some((scope) => scopes.includes(scope)))) {
    return back(permissionMessage);
  }
  if (typeof tok.refresh_token !== "string" || !tok.refresh_token) {
    return back("Google didn't allow ongoing access. Try signing in again.");
  }
  return { returnUrl, tokens: { ...tok, access_token: tok.access_token, refresh_token: tok.refresh_token } };
}

/** Never revoke on token rotation: Google can revoke the whole app's grant. */
export async function revokeGoogleGrant(fetcher: Fetcher, token: string): Promise<void> {
  try {
    await googlePostForm(fetcher, REVOKE_URL, { token });
  } catch {
    /* best effort; the stored connection is still forgotten */
  }
}

export function googleTokenExpiry(now: number, expiresIn?: number): number {
  return now + Math.max(60, typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000;
}

export async function googleAccessToken<T extends GoogleOAuthRow>(
  row: T,
  cfg: GoogleConfig,
  now: number,
  fetcher: Fetcher,
  save: (row: T) => Promise<boolean>,
  signInAgain: string,
  force = false,
): Promise<string> {
  if (!force && row.accessToken && row.accessExpires && row.accessExpires > now + 60_000) return row.accessToken;
  let res: Response;
  try {
    res = await googlePostForm(fetcher, TOKEN_URL, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: row.refreshToken,
      grant_type: "refresh_token",
    });
  } catch {
    throw new CalendarInputError("Couldn't reach Google. Try again in a minute.", 502);
  }
  const tok = await googleReadJson<GoogleTokens>(res);
  if (!res.ok || typeof tok?.access_token !== "string" || !tok.access_token) {
    if (tok?.error === "invalid_grant") {
      await save({ ...row, accessToken: null, accessExpires: null, problem: signInAgain });
      throw new CalendarInputError(signInAgain, 502);
    }
    throw new CalendarInputError(
      `Google sign-in check failed (${tok?.error ?? res.status}). Check the server's Google settings.`, 502,
    );
  }
  const next: T = {
    ...row,
    accessToken: tok.access_token,
    accessExpires: googleTokenExpiry(now, tok.expires_in),
    problem: null,
  };
  if (!(await save(next))) {
    throw new CalendarInputError("The Google connection changed while checking. Existing reminders were kept; try again.", 502);
  }
  Object.assign(row, next);
  return tok.access_token;
}

export async function googleApiGet<T>(
  fetcher: Fetcher,
  url: string,
  token: string,
  service: "Calendar" | "Classroom",
): Promise<{ status: number; body: T | null }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch {
    throw new CalendarInputError(`Couldn't reach Google ${service}. Try again in a minute.`, 502);
  }
  return { status: res.status, body: res.ok ? await googleReadJson<T>(res) : null };
}

export const MAX_GOOGLE_CONNECTIONS = 10;

/** Own account identity only — never Classroom rosters or another user's profile. */
export async function googleProfile(fetcher: Fetcher, token: string): Promise<{ sub: string; email: string | null }> {
  const response = await googleApiGet<{ sub?: unknown; email?: unknown }>(
    fetcher, "https://openidconnect.googleapis.com/v1/userinfo", token, "Calendar",
  );
  const profile = response.body;
  if (response.status !== 200 || typeof profile?.sub !== "string" || !profile.sub || profile.sub.length > 240) {
    throw new CalendarInputError("Couldn't identify your Google account. Try signing in again.", 502);
  }
  return { sub: profile.sub, email: typeof profile.email === "string" ? profile.email : null };
}

/**
 * Revocation is account-wide. Unknown legacy identities are treated
 * conservatively until reauthorized; never break a still-connected account.
 */
export async function googleGrantStillUsed(store: Store, identity: string | null): Promise<boolean> {
  const [calendars, classrooms] = await Promise.all([store.listGoogle(), store.listClassroom()]);
  if (!identity) return calendars.length + classrooms.length > 0;
  return calendars.some((r) => !r.accountId || r.accountId === identity) || classrooms.some((r) => r.accountId === identity);
}
