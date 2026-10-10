// Reminder alerts for the website / installed app.
//
// Honest limits: the page has to be alive for a reminder to fire (open tab,
// or the installed app in the background on Android). Reminders that come due
// while the app is fully closed are still shown the next time it opens, in
// the "Due" section. True closed-app push needs a Web Push server (see README).

import { itemTitle, remindersDueBetween, type Note } from "@pocketed/shared";

export type AlertState = "unsupported" | "default" | "granted" | "denied";

const CHECKED_KEY = "pocketed.v2.alertsCheckedAt";
const TICK_MS = 15_000;

export function alertState(): AlertState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Must be called from a click handler (browsers require a user gesture). */
export async function requestAlerts(): Promise<AlertState> {
  if (alertState() === "unsupported") return "unsupported";
  await Notification.requestPermission();
  return alertState();
}

/**
 * Shows a notification. On Android Chrome only the service worker can show
 * notifications, so prefer that and fall back to the page API.
 */
export async function showAlert(title: string, body: string, tag: string): Promise<void> {
  const options: NotificationOptions = {
    body,
    tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: "/" },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
  } catch {
    /* fall through to the page API */
  }
  if ("Notification" in window) new Notification(title, options);
}

/**
 * Watches the note list and alerts once per reminder when its time passes.
 * Only reminders that come due *after* the watcher starts (or after it last
 * ticked) are announced, so opening the app never triggers a burst of old ones.
 */
export class ReminderWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private notes: () => Note[]) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") this.tick();
  };

  tick(now = Date.now()): void {
    const last = Number(localStorage.getItem(CHECKED_KEY));
    localStorage.setItem(CHECKED_KEY, String(now));
    if (!last || last > now) return; // first run, or the clock went backwards
    if (alertState() !== "granted") return;
    for (const n of remindersDueBetween(this.notes(), last, now)) {
      const title = itemTitle(n) || "Reminder";
      const body = n.location ? `${title} · 📍 ${n.location}` : title;
      void showAlert("⏰ Reminder", body, `${n.id}:${n.reminderAt}`);
    }
  }
}
