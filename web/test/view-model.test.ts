import { describe, expect, it } from "vitest";
import type { Note } from "@pocketed/shared";
import {
  colorPickerChoices,
  colorsInUse,
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
    // The retired names count as the Google shade they're shown as.
    expect(colorCounts["#e67c73"]).toBe(1); // Ruby -> Flamingo
    expect(colorCounts["#009688"]).toBe(1); // Emerald -> Eucalyptus
    expect(colorCounts.ruby).toBeUndefined();
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

describe("Google Calendar colours", () => {
  const list = [
    mk("a", { reminderAt: NOW, color: "#0b8043" }),
    mk("b", { reminderAt: NOW, color: "#d50000" }),
    mk("c", { reminderAt: NOW, color: "#123456" }),
    mk("d", { reminderAt: NOW, color: "#d50000" }),
    mk("e", { reminderAt: NOW, color: "sky" }), // coloured before the palette changed
    mk("f", { reminderAt: NOW, color: "#7986cb", deleted: true }),
    mk("g", { color: "#7986cb" }), // a note, not a reminder
  ];

  it("are counted by shade, with a retired name read as its Google colour", () => {
    const counts = reminderColorCounts(list);
    expect(counts.all).toBe(5);
    expect(counts["#d50000"]).toBe(2);
    expect(counts["#0b8043"]).toBe(1);
    expect(counts["#039be5"]).toBe(1); // "sky" is shown as Peacock
    expect(counts.sky).toBeUndefined();
    expect(counts["#7986cb"]).toBeUndefined(); // deleted, and a note
  });

  it("become filter chips in Google's order, with Google's names", () => {
    expect(colorsInUse(list).map((c) => [c.id, c.label])).toEqual([
      ["#d50000", "Tomato"],
      ["#0b8043", "Basil"],
      ["#039be5", "Peacock"],
      ["#123456", "Custom"],
    ]);
  });

  it("offer Google's palette in the picker, with a custom shade kept selectable", () => {
    const palette = colorPickerChoices(null);
    expect(palette).toHaveLength(24);
    expect(palette[0]).toMatchObject({ id: "#d50000", label: "Tomato" });
    expect(palette.map((c) => c.id)).toContain("#c0ca33"); // Avocado
    // A colour that is already in the palette isn't offered twice…
    expect(colorPickerChoices("sky")).toHaveLength(24);
    expect(colorPickerChoices("#0b8043")).toHaveLength(24);
    // …but a shade from Google's own colour picker stays selectable.
    const custom = colorPickerChoices("#123456");
    expect(custom).toHaveLength(25);
    expect(custom[0]).toMatchObject({ id: "#123456", label: "Custom" });
  });
});
