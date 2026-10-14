// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteItem, createReminderItem, emptyState } from "@pocketed/shared";
import { Notes } from "../src/components/Notes";
import { SyncManager } from "../src/store";
import { backend, CFG } from "./fake-google-accounts";

let manager: SyncManager;
let host: HTMLDivElement;
let root: Root;
const button = (label: string) => {
  const b = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  if (!b) throw new Error(`Missing button: ${label}`);
  return b;
};
async function render() { await act(async () => root.render(<Notes manager={manager} onNewCfg={() => {}} />)); }
async function click(label: string) { await act(async () => button(label).click()); }
async function type(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); history.replaceState(null, "", "/");
  delete document.documentElement.dataset.themePreference;
  const mock = backend(); mock.server.accounts = []; mock.server.classAccounts = [];
  vi.stubGlobal("fetch", mock.fetchMock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  Element.prototype.scrollIntoView = vi.fn();
  manager = new SyncManager(CFG);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); manager.stop(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("redesigned workspace", () => {
  it("shows meaningful empty states and real summary counts without seed data", async () => {
    await render();
    expect(host.querySelector("h1")?.textContent).toBe("Your day, in perspective.");
    expect([...host.querySelectorAll(".stat-card strong")].map((el) => el.textContent)).toEqual(["00", "00", "00", "00"]);
    expect(host.textContent).toContain("Your next idea starts here.");
    expect(host.textContent).toContain("All clear.");
    expect(host.querySelector<HTMLElement>(".creator-shell")!.hidden).toBe(true);
  });

  it("does not count deleted notes or completed reminders as notes", async () => {
    const now = Date.now();
    const a = createNoteItem(emptyState(), { title: "A real note", body: "A useful idea" }, now);
    const b = createReminderItem(a.state, { title: "Completed reminder", reminderAt: now + 60000 }, now);
    const c = createNoteItem(b.state, { title: "Deleted note", body: "" }, now);
    manager.state = c.state;
    manager.state.notes[b.note.id].reminderAt = null;
    manager.state.notes[c.note.id].deleted = true;
    await render();
    expect(host.querySelector(".stat-card strong")?.textContent).toBe("01");
    expect(host.querySelector(".recent-notes")?.textContent).toContain("A real note");
    expect(host.querySelector(".recent-notes")?.textContent).not.toContain("Completed reminder");
    expect(host.textContent).not.toContain("Deleted note");
  });

  it("opens and closes the editor without losing a draft, then creates a real note", async () => {
    await render(); await click("New note");
    expect(host.querySelector<HTMLElement>(".creator-shell")!.hidden).toBe(false);
    await type("Note title", "Plan for tomorrow");
    await click("Close composer");
    expect(document.activeElement).toBe(button("New note"));
    await click("New note");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Note title"]')!.value).toBe("Plan for tomorrow");
    await act(async () => host.querySelector(".note-composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(Object.values(manager.state.notes).some((note) => note.title === "Plan for tomorrow")).toBe(true);
    expect(host.querySelector(".recent-notes")?.textContent).toContain("Plan for tomorrow");
    expect(host.querySelector(".stat-card strong")?.textContent).toBe("01");
  });

  it("restores the existing text draft on opening the workspace", async () => {
    localStorage.setItem("pocketed.v2.noteDraft", JSON.stringify({ title: "Kept draft", body: "", checklist: [], pinned: false }));
    await render();
    expect(host.querySelector<HTMLElement>(".creator-shell")!.hidden).toBe(false);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Note title"]')!.value).toBe("Kept draft");
  });

  it("opens reminder creation from the overview and saves a reminder", async () => {
    await render(); await click("Add reminder");
    expect(host.querySelector<HTMLElement>(".creator-shell")!.hidden).toBe(false);
    expect(host.querySelector(".reminder-composer")).not.toBeNull();
    await type("Reminder title", "Review priorities");
    await act(async () => host.querySelector(".reminder-composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const reminder = Object.values(manager.state.notes).find((n) => n.title === "Review priorities");
    expect(reminder?.kind).toBe("reminder");
    expect(reminder?.reminderAt).toBeGreaterThan(Date.now());
  });

  it("opens accessible settings, switches theme, and restores focus on Escape", async () => {
    await render(); button("Settings").focus(); await click("Settings");
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    const dark = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Dark")!;
    await act(async () => dark.click());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("pocketed.v2.theme")).toBe("dark");
    expect(button("Dark").getAttribute("aria-pressed")).toBe("true");
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Settings"));
  });
});
