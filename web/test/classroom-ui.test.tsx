import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyState, reconcileClassroom, type ClassroomFeed } from "@pocketed/shared";
import { GoogleClassroom, classroomChanges } from "../src/components/GoogleClassroom";
import { ReminderCard } from "../src/components/Notes";
import { ReminderCalendar } from "../src/components/ReminderCalendar";
import { SyncManager } from "../src/store";

const NOW = Date.UTC(2026, 9, 13, 10);
const FEED: ClassroomFeed = {
  source: "classroom", accountId: "student", complete: true, checkedAt: NOW,
  courses: [{ id: "maths", name: "Maths" }],
  courseWork: [{
    id: "worksheet", courseId: "maths", state: "PUBLISHED", title: "Algebra worksheet",
    description: "Complete questions 1–10.",
    alternateLink: "https://classroom.google.com/c/example/a/worksheet/details",
    dueDate: { year: 2026, month: 10, day: 14 }, dueTime: { hours: 22, minutes: 59 },
  }],
};

beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());

describe("Classroom UI", () => {
  it("explains student access, automatic checks, undated work and read-only limits in Settings", () => {
    const manager = new SyncManager({ serverUrl: "https://sync.test", token: "password" });
    const html = renderToStaticMarkup(<GoogleClassroom manager={manager} />);
    expect(html).toContain("Google Classroom");
    expect(html).toContain("Loading Classroom connection");
    expect(html).toContain("Read-only");
    expect(html).toContain("15 minutes");
    expect(html).toContain("grades aren&#x27;t imported");
    expect(html).toContain("school may need to approve");
    expect(html).toContain("student&#x27;s own account");
  });

  it("shows the imported source and a clickable, safely opened Classroom assignment link", () => {
    const manager = new SyncManager({ serverUrl: "https://sync.test", token: "password" });
    manager.state = reconcileClassroom(emptyState(), FEED, NOW).state;
    const note = Object.values(manager.state.notes)[0];
    const html = renderToStaticMarkup(<ReminderCard note={note} now={NOW} manager={manager} onEdit={() => {}} />);
    // Source text remains accessible; decorative line icons replace emoji.
    expect(html).toContain("Google Classroom</span>");
    expect(html).toContain("Maths: Algebra worksheet");
    expect(html).toContain('href="https://classroom.google.com/c/example/a/worksheet/details"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open in Classroom");
    expect(html).toContain("does not submit work");
  });

  it("populates the existing reminders calendar without needing a separate calendar UI", () => {
    const state = reconcileClassroom(emptyState(), FEED, NOW).state;
    const html = renderToStaticMarkup(<ReminderCalendar
      notes={Object.values(state.notes)} sections={[]} now={NOW} colorFilter="all"
      onColorFilterChange={() => {}} onSelectSection={() => {}} onQuickAddReminderForDate={() => {}}
      renderReminderCard={(note) => <li key={note.id}>{note.title}</li>}
    />);
    expect(html).toContain("Maths: Algebra worksheet");
    expect(html).toContain("Basil");
  });

  it("reports skipped and unreadable work instead of suggesting every assignment was imported", () => {
    expect(classroomChanges({ added: 2, updated: 1, removed: 0, undated: 3, invalid: 1, capped: 2 }))
      .toBe("2 added, 1 updated. 3 items without a due date left off the calendar. 1 deadline couldn't be read; any existing reminders were kept. 2 assignments left out by the import limit.");
  });
});
