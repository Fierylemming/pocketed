// Google sends each integration back with its own marker. Read once on app
// startup, clean the URL, and let only the matching Settings section consume it.

export type GoogleService = "calendar" | "classroom";
export type GoogleReturn = { ok: true; accountId?: string } | { ok: false; message: string };

export function parseGoogleReturn(hash: string, service: GoogleService = "calendar"): GoogleReturn | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const v = q.get(service === "calendar" ? "google" : "classroom");
  if (v === "connected") {
    const id = q.get("account");
    return id && id.length <= 256 ? { ok: true, accountId: id } : { ok: true };
  }
  if (v === "error") {
    return { ok: false, message: (q.get("message") ?? "").slice(0, 300) || "Google sign-in failed." };
  }
  return null;
}

function readOnce(): Record<GoogleService, GoogleReturn | null> {
  const result: Record<GoogleService, GoogleReturn | null> = { calendar: null, classroom: null };
  if (typeof window === "undefined") return result;
  result.calendar = parseGoogleReturn(window.location.hash);
  result.classroom = parseGoogleReturn(window.location.hash, "classroom");
  if (result.calendar || result.classroom) {
    try {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      /* ignore */
    }
  }
  return result;
}

const pending = readOnce();

/** Open Settings after either Google integration returns. */
export function hasGoogleReturn(): boolean {
  return pending.calendar !== null || pending.classroom !== null;
}

/** The matching sign-in outcome, handed out once without consuming the other. */
export function takeGoogleReturn(service: GoogleService = "calendar"): GoogleReturn | null {
  const r = pending[service];
  pending[service] = null;
  return r;
}
