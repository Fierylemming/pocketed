// The server URL is baked in at build time by CI (VITE_SERVER_URL), so the
// published site only ever asks for the password. When running a local dev
// build the field is shown instead.
// `npm run dev` talks to a local API started with `npm run dev:server`.
export const DEFAULT_SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (import.meta.env.DEV
    ? typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:8787"
    : "");

export interface Config {
  serverUrl: string;
  token: string;
}

const CFG_KEY = "pocketed.v2.cfg";
const STATE_KEY = "pocketed.v2.state";

export function loadCfg(): Config | null {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Config;
    if (typeof c?.serverUrl === "string" && typeof c?.token === "string" && c.token) {
      return c;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCfg(cfg: Config): void {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function clearAll(): void {
  localStorage.removeItem(CFG_KEY);
  localStorage.removeItem(STATE_KEY);
}

export { STATE_KEY };
