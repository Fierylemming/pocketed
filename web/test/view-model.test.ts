import { describe, expect, it } from "vitest";
import type { Note } from "@pocketed/shared";
import { matchesQuery, reminderMeta, sectionsFor, syncStatus } from "../src/view-model";

const NOW = 1_700_000_000_000;

const mk = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  text: id,
  createdAt: NOW,
  updatedAt: NOW,
  reminderAt: null,
  deleted: false,
  ...over,
});

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

describe("reminderMeta", () => {
  it("labels notes that carry a reminder", () => {
    const n = mk("call mum", { reminderAt: NOW + 3_600_000 });
    expect(reminderMeta(n, NOW)).toMatch(/⏰/);
    expect(reminderMeta({ ...n, reminderAt: null }, NOW)).toBeNull();
  });
});

describe("sectionsFor", () => {
  it("splits due, upcoming and plain notes", () => {
    const list = [
      mk("late", { reminderAt: NOW - 60_000 }),
      mk("later", { reminderAt: NOW + 120_000 }),
      mk("soon", { reminderAt: NOW + 60_000 }),
      mk("plain", { updatedAt: NOW + 5 }),
      mk("plain-old", { updatedAt: NOW - 5 }),
      mk("gone", { deleted: true, reminderAt: NOW - 1 }),
    ];
    const s = sectionsFor(list, NOW);
    expect(s.due.map((n) => n.id)).toEqual(["late"]);
    expect(s.upcoming.map((n) => n.id)).toEqual(["soon", "later"]);
    expect(s.notes.map((n) => n.id)).toEqual(["plain", "plain-old"]);
  });
});

describe("matchesQuery", () => {
  it("is case-insensitive and ignores blank queries", () => {
    const n = mk("x", { text: "Buy OAT milk\nand bread" });
    expect(matchesQuery(n, "")).toBe(true);
    expect(matchesQuery(n, "   ")).toBe(true);
    expect(matchesQuery(n, "oat")).toBe(true);
    expect(matchesQuery(n, "BREAD")).toBe(true);
    expect(matchesQuery(n, "eggs")).toBe(false);
  });
});
