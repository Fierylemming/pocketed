// After "Sign in with Google", the sync server sends the browser back to the
// app with the outcome in the address: #google=connected, or
// #google=error&message=…. Read it once at start-up and tidy the address.

export type GoogleReturn = { ok: true } | { ok: false; message: string };

export function parseGoogleReturn(hash: string): GoogleReturn | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const v = q.get("google");
  if (v === "connected") return { ok: true };
  if (v === "error") {
    return { ok: false, message: (q.get("message") ?? "").slice(0, 300) || "Google sign-in failed." };
  }
  return null;
}

function readOnce(): GoogleReturn | null {
  if (typeof window === "undefined") return null;
  const r = parseGoogleReturn(window.location.hash);
  if (r) {
    try {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      /* ignore */
    }
  }
  return r;
}

let pending: GoogleReturn | null = readOnce();

/** Whether the app was just opened by Google's sign-in redirect. */
export function hasGoogleReturn(): boolean {
  return pending !== null;
}

/** The sign-in outcome, handed out once. */
export function takeGoogleReturn(): GoogleReturn | null {
  const r = pending;
  pending = null;
  return r;
}
