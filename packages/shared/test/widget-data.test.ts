import { describe, expect, it } from "vitest";
import type { Note } from "../src/protocol";
import { buildWidgetData, itemsForHeight, shortAgo } from "../src/widget-data";

const NOW = 1_700_000_000_000;

const note = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  text: id,
  createdAt: NOW,
  updatedAt: NOW,
  reminderAt: null,
  deleted: false,
  ...over,
});

describe("widget data", () => {
  it("orders overdue, then upcoming reminders, then plain notes", () => {
    const items = buildWidgetData(
      [
        note("plain", { updatedAt: NOW - 1 }),
        note("late", { reminderAt: NOW - 60_000 }),
        note("soon", { reminderAt: NOW + 60_000 }),
      ],
      NOW,
    ).items;
    expect(items.map((i) => i.kind)).toEqual(["overdue", "reminder", "note"]);
  });

  it("excludes deleted notes and caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => note("n" + i));
    const data = buildWidgetData([...many, note("gone", { deleted: true })], NOW, 12);
    expect(data.items).toHaveLength(12);
    expect(data.items.find((i) => i.id === "gone")).toBeUndefined();
  });

  it("fits rows to height", () => {
    expect(itemsForHeight(200)).toBe(Math.floor((200 - 40) / 44));
    expect(itemsForHeight(10)).toBe(1);
  });

  it("shortAgo buckets", () => {
    expect(shortAgo(NOW - 5_000, NOW)).toBe("just now");
    expect(shortAgo(NOW - 120_000, NOW)).toBe("2m ago");
    expect(shortAgo(NOW - 7_200_000, NOW)).toBe("2h ago");
    expect(shortAgo(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });
});
