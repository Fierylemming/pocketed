import { describe, expect, it } from "vitest";
import type { Note } from "@pocketed/shared";
import {
  itemsInSection,
  matchesQuery,
  reminderColorCounts,
  reminderMeta,
  sectionCounts,
  sectionsFor,
  syncStatus,
} from "../src/view-model";

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

  it("mentions an early alert (imported calendar events)", () => {
    const n = mk("dentist", { reminderAt: NOW + 3_600_000, alertBefore: 30 });
    expect(reminderMeta(n, NOW)).toMatch(/🔔 30 min before$/);
    expect(reminderMeta({ ...n, alertBefore: null }, NOW)).not.toMatch(/🔔/);
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

describe("itemsInSection & sectionCounts", () => {
  it("separates notes and reminders per section folder and counts due items", () => {
    const list = [
      mk("n1", { kind: "note", sectionId: "sec-1", updatedAt: NOW + 10 }),
      mk("r1", {
        kind: "reminder",
        sectionId: "sec-1",
        reminderAt: NOW - 1000,
        color: "ruby",
      }),
      mk("r2", {
        kind: "reminder",
        sectionId: "sec-1",
        reminderAt: NOW + 5000,
        color: "emerald",
      }),
      mk("other-sec", { kind: "note", sectionId: "sec-2" }),
    ];

    const folder = itemsInSection(list, "sec-1");
    expect(folder.notes.map((n) => n.id)).toEqual(["n1"]);
    expect(folder.reminders.map((r) => r.id)).toEqual(["r1", "r2"]);

    const counts = sectionCounts(list, "sec-1", NOW);
    expect(counts).toEqual({ notes: 1, reminders: 2, due: 1 });

    const colorCounts = reminderColorCounts(list);
    expect(colorCounts.all).toBe(2);
    expect(colorCounts.ruby).toBe(1);
    expect(colorCounts.emerald).toBe(1);
  });
});

describe("matchesQuery", () => {
  it("is case-insensitive and matches text, title, body, location, and checklist", () => {
    const n = mk("x", {
      text: "Buy OAT milk\nand bread",
      location: "Downtown Market",
      checklist: [{ id: "1", text: "Check expiry date", done: false }],
    });
    expect(matchesQuery(n, "")).toBe(true);
    expect(matchesQuery(n, "   ")).toBe(true);
    expect(matchesQuery(n, "oat")).toBe(true);
    expect(matchesQuery(n, "BREAD")).toBe(true);
    expect(matchesQuery(n, "downtown")).toBe(true);
    expect(matchesQuery(n, "expiry")).toBe(true);
    expect(matchesQuery(n, "eggs")).toBe(false);
  });
});
