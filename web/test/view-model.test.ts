import { describe, expect, it } from "vitest";
import type { Note } from "@pocketed/shared";
import { reminderAtFor, reminderMeta, syncStatus } from "../src/view-model";

const NOW = 1_700_000_000_000;

describe("syncStatus", () => {
  it("describes each phase", () => {
    expect(syncStatus("syncing", null, NOW, null)).toBe("Syncing…");
    expect(syncStatus("offline", null, NOW, null)).toMatch(/Offline/);
    expect(syncStatus("error", null, NOW, "boom")).toBe("boom");
    expect(syncStatus("synced", NOW - 10_000, NOW, null)).toBe("Synced just now");
    expect(syncStatus("synced", NOW - 5 * 60_000, NOW, null)).toBe("Synced 5m ago");
    expect(syncStatus("synced", NOW - 3 * 3_600_000, NOW, null)).toBe("Synced 3h ago");
  });
});

describe("reminders in the composer", () => {
  it("choice maps to a timestamp or null", () => {
    expect(reminderAtFor("none", NOW)).toBeNull();
    const h = reminderAtFor("1h", NOW)!;
    expect(h).toBeGreaterThan(NOW);
    expect(h % 60_000).toBe(0);
    const tm = reminderAtFor("tomorrow", NOW)!;
    const d = new Date(tm);
    expect(d.getHours()).toBe(9);
  });

  it("labels notes that carry a reminder", () => {
    const n: Note = {
      id: "x",
      text: "call mum",
      createdAt: NOW,
      updatedAt: NOW,
      reminderAt: NOW + 3_600_000,
      deleted: false,
    };
    expect(reminderMeta(n, NOW)).toMatch(/⏰/);
    expect(reminderMeta({ ...n, reminderAt: null }, NOW)).toBeNull();
  });
});
