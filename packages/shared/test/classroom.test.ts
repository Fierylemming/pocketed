import { describe, expect, it } from "vitest";
import {
  addNote,
  classroomDeadline,
  classroomLink,
  classroomNoteId,
  CLASSROOM_OVERDUE_DAYS,
  CLASSROOM_WINDOW_DAYS,
  deleteNote,
  emptyState,
  isClassroomFeed,
  LIMITS,
  markReminderDone,
  MAX_IMPORTED_ASSIGNMENTS,
  putItem,
  reconcileClassroom,
  removeClassroomReminders,
  updateItem,
  validateOp,
  type ClassroomCourseWork,
  type ClassroomFeed,
} from "../src";

const NOW = Date.UTC(2026, 9, 13, 10);
const DAY = 86_400_000;
const COURSE = { id: "maths", name: "Maths" };
const ACCOUNT = "student-google-id";

function work(id = "homework-1", at = NOW + DAY, overrides: Partial<ClassroomCourseWork> = {}): ClassroomCourseWork {
  const date = new Date(at);
  return {
    id, courseId: COURSE.id, state: "PUBLISHED", title: "Algebra worksheet", description: "Complete questions 1–10.",
    alternateLink: "https://classroom.google.com/c/example/a/worksheet/details",
    dueDate: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    dueTime: { hours: date.getUTCHours(), minutes: date.getUTCMinutes(), seconds: date.getUTCSeconds() },
    ...overrides,
  };
}

function feed(courseWork = [work()], overrides: Partial<ClassroomFeed> = {}): ClassroomFeed {
  return { source: "classroom", accountId: ACCOUNT, checkedAt: NOW, complete: true, courses: [COURSE], courseWork, ...overrides };
}

const noteId = (item: ClassroomCourseWork = work()) => classroomNoteId(ACCOUNT, item.courseId, item.id);

describe("Classroom deadlines and identity", () => {
  it("uses UTC, including omitted zero clock components, across UK daylight saving", () => {
    expect(classroomDeadline(work("midnight", Date.UTC(2026, 9, 14), { dueTime: {} }))).toBe(Date.UTC(2026, 9, 14));
    expect(classroomDeadline(work("bst", Date.UTC(2026, 9, 24, 22, 59), { dueTime: { hours: 22, minutes: 59 } })))
      .toBe(Date.UTC(2026, 9, 24, 22, 59));
    expect(classroomDeadline(work("gmt", Date.UTC(2026, 9, 26, 23, 59))))
      .toBe(Date.UTC(2026, 9, 26, 23, 59));
    expect(classroomDeadline(work("precise", NOW, { dueTime: { nanos: 123_456_789 } })))
      .toBe(Date.UTC(2026, 9, 13, 0, 0, 0, 123));
  });

  it.each([
    { dueDate: undefined },
    { dueTime: undefined },
    { dueDate: {} },
    { dueDate: { year: 2026, month: 2, day: 31 } },
    { dueDate: { year: 2026, month: 2, day: 29 } },
    { dueDate: { year: 2026, month: 13, day: 1 } },
    { dueDate: { year: 2026, month: 1, day: 0 } },
    { dueTime: { hours: 24 } },
    { dueTime: { minutes: -1 } },
    { dueTime: { seconds: 60 } },
    { dueTime: { hours: 10.5 } },
    { dueTime: { nanos: 1_000_000_000 } },
  ])("never invents or rolls over an invalid deadline: %j", (parts) => {
    expect(classroomDeadline(work("invalid", NOW, parts))).toBeNull();
  });

  it("has stable IDs, without collisions between accounts or courses", () => {
    const id = noteId();
    expect(id).toMatch(/^gclass-[0-9a-f]{16}-[0-9a-f]{16}$/);
    expect(noteId()).toBe(id);
    expect(classroomNoteId("another-account", "maths", "homework-1")).not.toBe(id);
    expect(classroomNoteId(ACCOUNT, "english", "homework-1")).not.toBe(id);
    expect(classroomNoteId(ACCOUNT, "maths", "homework-2")).not.toBe(id);
  });

  it("allows only safe Classroom links and protects the Markdown link boundary", () => {
    expect(classroomLink("https://classroom.google.com/c/a(1)/details"))
      .toBe("https://classroom.google.com/c/a%281%29/details");
    for (const url of ["javascript:alert(1)", "http://classroom.google.com/", "https://classroom.google.com.evil.test/",
      "https://user:password@classroom.google.com/", "https://classroom.google.com:444/", "https://drive.google.com/file"]) {
      expect(classroomLink(url)).toBeNull();
    }
    expect(classroomLink("https://classroom.google.com/" + "界".repeat(100))).toBeNull();
  });
});

describe("Classroom reconciliation", () => {
  it("creates calendar reminders with course, description, link and correct deadline, with valid sync ops", () => {
    const result = reconcileClassroom(emptyState(), feed(), NOW);
    expect(result).toMatchObject({ added: 1, updated: 0, removed: 0, undated: 0, invalid: 0, capped: 0 });
    expect(result.state.notes[noteId()]).toMatchObject({
      kind: "reminder", title: "Maths: Algebra worksheet", reminderAt: NOW + DAY,
      allDay: false, endAt: null, source: "classroom", alertBefore: 30, color: "#0b8043",
    });
    expect(result.state.notes[noteId()].body).toContain("[Open in Classroom](https://classroom.google.com/");
    expect(result.state.notes[noteId()].body).toContain("Complete questions 1–10.");
    expect(result.state.outbox.every((op) => validateOp(op) === null)).toBe(true);
    const unchanged = reconcileClassroom(result.state, feed(), NOW + 1);
    expect(unchanged).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(unchanged.state).toBe(result.state);
  });

  it("bounds text and preserves the link even with a long teacher description", () => {
    const item = work("long", NOW + DAY, { title: "T".repeat(500), description: "D".repeat(5000) });
    const result = reconcileClassroom(emptyState(), feed([item]), NOW);
    const note = result.state.notes[noteId(item)];
    expect(note.title?.length).toBe(LIMITS.noteTitleChars);
    expect(note.body?.length).toBe(LIMITS.reminderBodyChars);
    expect(note.body).toContain("[Open in Classroom]");
    expect(validateOp(result.state.outbox[0])).toBeNull();
  });

  it("updates teacher changes, including deadlines beyond the new-import window, but keeps personal choices", () => {
    let state = reconcileClassroom(emptyState(), feed(), NOW).state;
    state = updateItem(state, noteId(), { sectionId: "school", pinned: true, color: "#8e24aa", alertBefore: null }, NOW + 1);
    const moved = work("homework-1", NOW + 90 * DAY, { title: "Revised algebra", description: "Do question 11 too." });
    const result = reconcileClassroom(state, feed([moved]), NOW + 2);
    expect(result.updated).toBe(1);
    expect(result.state.notes[noteId()]).toMatchObject({
      title: "Maths: Revised algebra", reminderAt: NOW + 90 * DAY, sectionId: "school", pinned: true,
      color: "#8e24aa", alertBefore: null,
    });
  });

  it.each(["done", "deleted"] as const)("honours a manually %s reminder until the teacher changes its deadline", (action) => {
    let state = reconcileClassroom(emptyState(), feed(), NOW).state;
    state = action === "done" ? markReminderDone(state, noteId(), NOW + 1) : deleteNote(state, noteId(), NOW + 1);
    const changed = work("homework-1", NOW + DAY, { description: "A text edit" });
    const result = reconcileClassroom(state, feed([changed]), NOW + 2);
    expect(result.added + result.updated).toBe(0);
    expect(result.state.notes[noteId()]).toMatchObject(action === "done" ? { reminderAt: null } : { deleted: true });
    const rescheduled = reconcileClassroom(result.state, feed([work("homework-1", NOW + 2 * DAY)]), NOW + 3);
    expect(rescheduled.added).toBe(1);
    expect(rescheduled.state.notes[noteId()]).toMatchObject({ deleted: false, reminderAt: NOW + 2 * DAY });
  });

  it("skips undated and invalid work; a broken deadline cannot remove a previous reminder", () => {
    const state = reconcileClassroom(emptyState(), feed(), NOW).state;
    const result = reconcileClassroom(state, feed([
      work("homework-1", NOW + DAY, { dueTime: { hours: 30 } }),
      work("no-date", NOW + DAY, { dueDate: undefined, dueTime: undefined }),
    ]), NOW + 1);
    expect(result).toMatchObject({ invalid: 1, undated: 1, added: 0, updated: 0, removed: 0 });
    expect(result.state.notes[noteId()].reminderAt).toBe(NOW + DAY);
  });

  it("removes work only within a completely fetched active course, and can restore teacher-removed work", () => {
    const first = feed([work(), work("other", NOW + 2 * DAY)]);
    let state = reconcileClassroom(emptyState(), first, NOW).state;
    const emptyCourse = reconcileClassroom(state, feed([]), NOW + 1);
    expect(emptyCourse.removed).toBe(2);
    expect(emptyCourse.state.notes[noteId()].deleted).toBe(true);
    state = reconcileClassroom(emptyCourse.state, first, NOW + 2).state;
    expect(state.notes[noteId()]).toMatchObject({ deleted: false, reminderAt: NOW + DAY });
    expect(reconcileClassroom(state, feed([work("homework-1", NOW + DAY, { dueDate: undefined, dueTime: undefined })]), NOW + 3))
      .toMatchObject({ removed: 2, undated: 1 });
  });

  it("never sweeps other accounts, archived/inaccessible courses, Google Calendar or handmade notes", () => {
    let state = reconcileClassroom(emptyState(), feed(), NOW).state;
    state = reconcileClassroom(state, feed([work("homework-1", NOW + DAY, { courseId: "english" })], {
      courses: [{ id: "english", name: "English" }],
    }), NOW).state;
    state = addNote(state, "Personal note", null, NOW).state;
    state = putItem(state, "gcal-test", { text: "Calendar event", reminderAt: NOW + DAY, source: "gcal" }, NOW);
    expect(reconcileClassroom(state, feed([], { accountId: "someone-else" }), NOW + 1).removed).toBe(0);
    expect(reconcileClassroom(state, feed([], { courses: [] }), NOW + 1).removed).toBe(0);
    const result = reconcileClassroom(state, feed([]), NOW + 1);
    expect(result.removed).toBe(1); // only this account's Maths coursework
    expect(result.state.notes[classroomNoteId(ACCOUNT, "english", "homework-1")].deleted).toBe(false);
    expect(result.state.notes["gcal-test"].deleted).toBe(false);
    expect(Object.values(result.state.notes).find((n) => n.text === "Personal note")?.deleted).toBe(false);
  });

  it("imports recently overdue and upcoming work using the server clock, and leaves older deadlines alone", () => {
    const items = [
      work("older", NOW - (CLASSROOM_OVERDUE_DAYS + 1) * DAY),
      work("overdue", NOW - DAY),
      work("upcoming", NOW + CLASSROOM_WINDOW_DAYS * DAY),
      work("future", NOW + (CLASSROOM_WINDOW_DAYS + 1) * DAY),
    ];
    const result = reconcileClassroom(emptyState(), feed(items), NOW + 365 * DAY); // wrong device clock
    expect(result.added).toBe(2);
    expect(Object.keys(result.state.notes).sort()).toEqual([noteId(items[1]), noteId(items[2])].sort());
    const later = reconcileClassroom(result.state, feed(items, { checkedAt: NOW + 40 * DAY }), NOW + 40 * DAY);
    expect(later.removed).toBe(0); // deadlines aren't swept just for being overdue
  });

  it("caps NEW imports by earliest deadline, without losing existing work or mistaking the cap for deletion", () => {
    const items = Array.from({ length: MAX_IMPORTED_ASSIGNMENTS + 2 }, (_, i) => work(`assignment-${i}`, NOW + DAY + i * 60_000));
    const existing = reconcileClassroom(emptyState(), feed([items[items.length - 1]]), NOW).state;
    const result = reconcileClassroom(existing, feed([...items].reverse()), NOW + 1);
    expect(result).toMatchObject({ added: MAX_IMPORTED_ASSIGNMENTS, removed: 0, capped: 1 });
    expect(result.state.notes[noteId(items[0])]).toBeDefined();
    expect(result.state.notes[noteId(items[items.length - 1])]?.deleted).toBe(false);
  });

  it("disconnect removes only Classroom items, including completed ones", () => {
    let state = reconcileClassroom(emptyState(), feed(), NOW).state;
    state = markReminderDone(state, noteId(), NOW + 1);
    state = putItem(state, "gcal-test", { text: "Calendar event", reminderAt: NOW + DAY, source: "gcal" }, NOW);
    const result = removeClassroomReminders(state, NOW + 2);
    expect(result.removed).toBe(1);
    expect(result.state.notes[noteId()].deleted).toBe(true);
    expect(result.state.notes["gcal-test"].deleted).toBe(false);
  });
});

describe("Classroom feed validation", () => {
  it("accepts complete feeds, including genuinely empty accounts and classes", () => {
    expect(isClassroomFeed(feed())).toBe(true);
    expect(isClassroomFeed(feed([]))).toBe(true);
    expect(isClassroomFeed(feed([], { courses: [] }))).toBe(true);
  });

  it("rejects partial, malformed and cross-course lists before they can cause removals", () => {
    for (const invalid of [null, {}, { ...feed(), complete: false }, { ...feed(), accountId: "" },
      { ...feed(), courses: [COURSE, COURSE] }, { ...feed(), courseWork: "not an array" },
      { ...feed(), courseWork: [work("bad", NOW, { courseId: "unknown-course" })] },
      { ...feed(), courseWork: [{ ...work(), dueTime: { hours: "ten" } }] }]) {
      expect(isClassroomFeed(invalid)).toBe(false);
    }
  });
});
