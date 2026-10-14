// Read-only Google Classroom import. Deadlines belong in Pocketed's calendar,
// but are not Google Calendar events: they have their own IDs and source so
// connecting/disconnecting either integration cannot affect the other.

import { cleanDescription, cleanLine } from "./calendar-util";
import { hash64 } from "./calendar";
import {
  CALENDAR_ALERT_BEFORE_MINUTES,
  composeNoteText,
  LIMITS,
  truncate,
  type Note,
  type ReminderColorId,
} from "./protocol";
import { deleteNote, putItem, updateItem, type SyncState } from "./sync";

export const CLASSROOM_WINDOW_DAYS = 60;
/** Include recently overdue work, rather than hiding it as soon as it is due. */
export const CLASSROOM_OVERDUE_DAYS = 30;
export const MAX_IMPORTED_ASSIGNMENTS = 500;
export const CLASSROOM_REMOVED_REF = "classroom-removed";
export const CLASSROOM_REMINDER_COLOR: ReminderColorId = "#0b8043"; // Basil
const DAY = 86_400_000;

export interface ClassroomCourse {
  id: string;
  name: string;
}

export interface ClassroomDate {
  year?: number;
  month?: number;
  day?: number;
}

export interface ClassroomTime {
  hours?: number;
  minutes?: number;
  seconds?: number;
  nanos?: number;
}

/** Only coursework metadata; no submissions, grades, rosters or attachments. */
export interface ClassroomCourseWork {
  id: string;
  courseId: string;
  state: "PUBLISHED" | "DRAFT" | "DELETED";
  title?: string;
  description?: string;
  alternateLink?: string;
  dueDate?: ClassroomDate | null;
  dueTime?: ClassroomTime | null;
}

/** All published coursework from every active course the student is enrolled in. */
export interface ClassroomFeed {
  source: "classroom";
  /** Google's stable account ID (not a token); IDs must also distinguish accounts. */
  accountId: string;
  /** Server clock: a device with a bad clock cannot exclude assignments. */
  checkedAt: number;
  /** The server never returns a partial or truncated list. */
  complete: true;
  courses: ClassroomCourse[];
  courseWork: ClassroomCourseWork[];
}

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function optionalParts(v: unknown, keys: string[]): boolean {
  return v == null || (record(v) && keys.every((key) => v[key] === undefined || typeof v[key] === "number"));
}

/** A malformed/partial response must never be treated as an empty Classroom. */
export function isClassroomFeed(v: unknown): v is ClassroomFeed {
  if (!record(v) || v.source !== "classroom" || v.complete !== true ||
      typeof v.accountId !== "string" || !v.accountId ||
      typeof v.checkedAt !== "number" || !Number.isFinite(v.checkedAt) ||
      !Array.isArray(v.courses) || !Array.isArray(v.courseWork)) return false;
  const courseIds = new Set<string>();
  for (const course of v.courses) {
    if (!record(course) || typeof course.id !== "string" || !course.id ||
        typeof course.name !== "string" || courseIds.has(course.id)) return false;
    courseIds.add(course.id);
  }
  return v.courseWork.every((work: unknown) => record(work) &&
    typeof work.id === "string" && !!work.id &&
    typeof work.courseId === "string" && courseIds.has(work.courseId) &&
    typeof work.state === "string" && ["PUBLISHED", "DRAFT", "DELETED"].includes(work.state) &&
    ["title", "description", "alternateLink"].every((key) => work[key] === undefined || typeof work[key] === "string") &&
    optionalParts(work.dueDate, ["year", "month", "day"]) &&
    optionalParts(work.dueTime, ["hours", "minutes", "seconds", "nanos"]));
}

/**
 * Classroom's dueDate AND dueTime are UTC, not the school's/device's wall time.
 * Omitted clock components are zero (in particular, {} is midnight UTC).
 * Both messages are required for a deadline. Never invent a time for malformed
 * data, or let Date.UTC silently turn 31 February into a different deadline.
 */
export function classroomDeadline(work: Pick<ClassroomCourseWork, "dueDate" | "dueTime">): number | null {
  if (!work.dueDate || !work.dueTime) return null;
  const { year: y, month: mo, day: d } = work.dueDate;
  const { hours = 0, minutes = 0, seconds = 0, nanos = 0 } = work.dueTime;
  const bounded = (n: number | undefined, min: number, max: number): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  if (!bounded(y, 1970, 9999) || !bounded(mo, 1, 12) || !bounded(d, 1, 31) ||
      !bounded(hours, 0, 23) || !bounded(minutes, 0, 59) ||
      !bounded(seconds, 0, 59) || !bounded(nanos, 0, 999_999_999)) return null;
  const at = Date.UTC(y, mo - 1, d, hours, minutes, seconds, Math.floor(nanos / 1_000_000));
  const date = new Date(at);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? at : null;
}

function coursePrefix(accountId: string, courseId: string): string {
  return "gclass-" + hash64(JSON.stringify([accountId, courseId])) + "-";
}

/** Stable across devices, refreshes and teacher edits, distinct across courses/accounts. */
export function classroomNoteId(accountId: string, courseId: string, workId: string): string {
  return coursePrefix(accountId, courseId) + hash64(workId);
}

/** Only actual Classroom HTTPS links, never a URL assembled from its internal IDs. */
export function classroomLink(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 350) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "classroom.google.com" || u.port || u.username || u.password) return null;
    // A link in Markdown must not be able to close its own parentheses.
    const link = u.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
    return link.length <= 350 ? link : null;
  } catch {
    return null;
  }
}

function fieldsFor(course: ClassroomCourse, work: ClassroomCourseWork, due: number, prev: Note | null, accountId: string) {
  const courseName = truncate(cleanLine(course.name), 60);
  const title = truncate(`${courseName || "Classroom"}: ${cleanLine(work.title || "(Untitled assignment)")}`, LIMITS.noteTitleChars);
  const link = classroomLink(work.alternateLink);
  const prefix = link ? `[Open in Classroom](${link})\n\n` : "";
  const body = prefix + truncate(cleanDescription(work.description ?? ""), Math.max(0, LIMITS.reminderBodyChars - prefix.length));
  return {
    kind: "reminder" as const,
    title,
    body,
    text: composeNoteText(title, body),
    reminderAt: due,
    endAt: null,
    allDay: false,
    repeat: "none" as const,
    alertBefore: prev?.alertBefore !== undefined ? prev.alertBefore : CALENDAR_ALERT_BEFORE_MINUTES,
    source: "classroom" as const,
    sourceAccountId: accountId,
    sourceRef: `${due}:${hash64(JSON.stringify([title, body]))}`,
    // Teacher edits never move the assignment out of the user's folder, or
    // overwrite their colour, pin, attachments or checklist.
    sectionId: prev?.sectionId ?? null,
    location: prev?.location ?? null,
    color: prev?.color ?? CLASSROOM_REMINDER_COLOR,
    pinned: prev?.pinned ?? false,
    images: prev?.images ?? [],
    checklist: prev?.checklist ?? [],
    createdAt: prev?.createdAt,
  };
}

export interface ClassroomImportResult {
  state: SyncState;
  added: number;
  updated: number;
  removed: number;
  /** Published items without a deadline cannot go on a calendar. */
  undated: number;
  /** Malformed deadlines are skipped, without changing a previous reminder. */
  invalid: number;
  /** New dated items inside the window left out by the import cap. */
  capped: number;
}

/**
 * Reconcile a FULL snapshot of student coursework. Unlike the time-bounded
 * Calendar feed, this lists every published item in each returned course, so
 * absence within one successfully fetched course is evidence that the item is
 * no longer assigned. Courses that drop out (archived/inaccessible), other
 * Google accounts, handmade notes and Calendar events are always left alone.
 * Overdue reminders remain until dismissed or removed by the teacher.
 */
export function reconcileClassroom(state: SyncState, feed: ClassroomFeed, now: number): ClassroomImportResult {
  let s = state;
  let added = 0;
  let updated = 0;
  let removed = 0;
  let undated = 0;
  let invalid = 0;
  let capped = 0;
  const courses = new Map(feed.courses.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const candidates: { id: string; course: ClassroomCourse; work: ClassroomCourseWork; due: number }[] = [];

  const removeFromTeacher = (id: string) => {
    const prev = s.notes[id];
    if (!prev || prev.source !== "classroom" || prev.deleted || prev.reminderAt == null) return;
    // Distinguish a teacher removing work from a student's manual dismissal.
    // If the teacher republishes the same deadline, it can be restored.
    s = deleteNote(s, id, now, CLASSROOM_REMOVED_REF);
    removed++;
  };

  for (const work of feed.courseWork) {
    const course = courses.get(work.courseId);
    if (!course) continue;
    const id = classroomNoteId(feed.accountId, course.id, work.id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (work.state === "DELETED") {
      removeFromTeacher(id);
      continue;
    }
    if (work.state !== "PUBLISHED") continue;
    if (!work.dueDate) {
      undated++;
      removeFromTeacher(id);
      continue;
    }
    const due = classroomDeadline(work);
    if (due == null) {
      invalid++;
      continue; // never erase a previous deadline on the basis of bad data
    }
    candidates.push({ id, course, work, due });
  }

  candidates.sort((a, b) => a.due - b.due || a.id.localeCompare(b.id));
  const from = feed.checkedAt - CLASSROOM_OVERDUE_DAYS * DAY;
  const to = feed.checkedAt + CLASSROOM_WINDOW_DAYS * DAY;
  let newItems = 0;
  for (const { id, course, work, due } of candidates) {
    const prev = s.notes[id] ?? null;
    if (!prev) {
      if (due < from || due > to) continue;
      if (newItems >= MAX_IMPORTED_ASSIGNMENTS) {
        capped++;
        continue;
      }
      newItems++;
      s = putItem(s, id, fieldsFor(course, work, due, null, feed.accountId), now);
      added++;
      continue;
    }
    const fields = fieldsFor(course, work, due, prev, feed.accountId);
    if (prev.sourceRef === fields.sourceRef) {
      if (!prev.deleted && prev.sourceAccountId !== feed.accountId) {
        s = updateItem(s, id, { sourceAccountId: feed.accountId }, now);
        updated++;
      }
      continue;
    }
    const dismissed = prev.deleted || prev.reminderAt == null;
    // ✅ and 🗑️ are Pocketed-only decisions. A description edit does not undo
    // them; a new deadline does. No write ever goes back to Classroom.
    if (dismissed && Number(prev.sourceRef?.split(":")[0]) === due) continue;
    s = putItem(s, id, fields, now);
    if (dismissed) added++;
    else updated++;
  }

  const prefixes = new Set(feed.courses.map((c) => coursePrefix(feed.accountId, c.id)));
  for (const n of Object.values(s.notes)) {
    if (n.source !== "classroom" || n.deleted || seen.has(n.id)) continue;
    const prefix = n.id.slice(0, n.id.lastIndexOf("-") + 1);
    if (prefixes.has(prefix)) removeFromTeacher(n.id);
  }
  return { state: s, added, updated, removed, undated, invalid, capped };
}

/** Disconnecting Classroom never removes Google Calendar or handmade items. */
export function removeClassroomReminders(state: SyncState, now: number, accountId?: string, legacyNotes = false): { state: SyncState; removed: number } {
  let s = state;
  let removed = 0;
  for (const n of Object.values(s.notes)) {
    if (n.source !== "classroom" || n.deleted || (accountId && n.sourceAccountId !== accountId && !(legacyNotes && !n.sourceAccountId))) continue;
    s = deleteNote(s, n.id, now, CLASSROOM_REMOVED_REF);
    removed++;
  }
  return { state: s, removed };
}
