import { useState } from "react";
import {
  buildCalendarMonth,
  DEFAULT_REMINDER_COLOR,
  filterRemindersByColor,
  formatSpanLabel,
  getReminderColor,
  itemTitle,
  localDateKey,
  normalizeReminderColor,
  reminderCoversDay,
  truncate,
  type CalendarEntry,
  type Note,
  type ReminderColorId,
  type Section,
} from "@pocketed/shared";
import { colorsInUse, reminderColorCounts } from "../view-model";

/** Rows of reminders shown inside a day cell before "+N more". */
const MAX_SLOTS = 3;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function ReminderCalendar({
  notes,
  sections,
  now,
  colorFilter,
  onColorFilterChange,
  onSelectSection,
  onQuickAddReminderForDate,
  renderReminderCard,
}: {
  notes: Note[];
  sections: Section[];
  now: number;
  colorFilter: ReminderColorId | "all";
  onColorFilterChange: (color: ReminderColorId | "all") => void;
  onSelectSection: (sectionId: string) => void;
  onQuickAddReminderForDate: (ts: number, color: ReminderColorId) => void;
  renderReminderCard: (note: Note, sectionBadge?: Section | null) => React.ReactNode;
}) {
  const todayDate = new Date(now);
  const [viewYear, setViewYear] = useState(todayDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(todayDate.getMonth());
  const [selectedDateKey, setSelectedDateKey] = useState<string>(() =>
    localDateKey(now),
  );
  const [listMode, setListMode] = useState<"day" | "all">("day");

  const counts = reminderColorCounts(notes);
  // One chip per colour your reminders actually use (Google Calendar's shades),
  // plus the one being filtered by, so the bar stays short.
  const chipColors = colorsInUse(notes);
  const activeColor = colorFilter === "all" ? null : normalizeReminderColor(colorFilter);
  if (activeColor && !chipColors.some((c) => c.id === activeColor)) {
    chipColors.push(getReminderColor(activeColor));
  }
  const calendarDays = buildCalendarMonth(
    viewYear,
    viewMonth,
    notes,
    now,
    colorFilter,
  );
  const filteredReminders = filterRemindersByColor(notes, colorFilter);

  const selectedDayObj = calendarDays.find((d) => d.dateKey === selectedDateKey);
  const dayReminders = selectedDayObj
    ? selectedDayObj.reminders
    : filteredReminders.filter((r) => reminderCoversDay(r, selectedDateKey));

  const sectionMap = new Map(sections.map((s) => [s.id, s]));

  function prevMonth() {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  function goToday() {
    const d = new Date(Date.now());
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
    setSelectedDateKey(localDateKey(d.getTime()));
    setListMode("day");
  }

  function defaultTimeForSelectedDate(): number {
    const [y, m, d] = selectedDateKey.split("-").map(Number);
    const target = new Date(y, m - 1, d, 9, 0, 0, 0);
    if (target.getTime() <= Date.now()) {
      // If selected day is today (or past), set to 1 hour from now
      return Math.round((Date.now() + 3_600_000) / 60_000) * 60_000;
    }
    return target.getTime();
  }

  const displayedReminders = listMode === "day" ? dayReminders : filteredReminders;

  return (
    <section className="calendar-card" aria-label="Reminders Calendar">
      <div className="calendar-top">
        <div>
          <h2 className="calendar-heading">📅 Reminders Calendar</h2>
          <p className="muted small calendar-sub">
            Click a colour to filter reminders, or select a date to view and schedule. Events that
            run across several days show as one bar.
          </p>
        </div>
        <div className="calendar-nav">
          <button
            type="button"
            className="small-btn"
            aria-label="Previous month"
            onClick={prevMonth}
          >
            ‹
          </button>
          <span className="calendar-month-label">
            {MONTHS[viewMonth]} {viewYear}
          </span>
          <button
            type="button"
            className="small-btn"
            aria-label="Next month"
            onClick={nextMonth}
          >
            ›
          </button>
          <button type="button" className="small-btn" onClick={goToday}>
            Today
          </button>
        </div>
      </div>

      {/* Colour Filter Bar */}
      <div className="color-filter-bar" role="group" aria-label="Filter calendar by colour">
        <button
          type="button"
          className={"color-chip" + (colorFilter === "all" ? " active" : "")}
          onClick={() => onColorFilterChange("all")}
        >
          <span className="color-dot all-dot" />
          <span>All colours</span>
          <span className="chip-count">{counts.all}</span>
        </button>
        {chipColors.map((c) => {
          const active = colorFilter === c.id;
          return (
            <button
              key={c.id}
              type="button"
              className={"color-chip" + (active ? " active" : "")}
              style={
                active
                  ? { borderColor: c.border, background: c.bg }
                  : undefined
              }
              onClick={() =>
                onColorFilterChange(active ? "all" : c.id)
              }
              aria-pressed={active}
              title={`Filter by ${c.label}`}
            >
              <span
                className="color-dot"
                style={{ backgroundColor: c.hex }}
              />
              <span>{c.label}</span>
              <span className="chip-count">{counts[c.id] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Calendar Grid */}
      <div className="calendar-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="calendar-weekday">
            {w}
          </div>
        ))}
        {calendarDays.map((cell, index) => {
          const isSelected = cell.dateKey === selectedDateKey;
          const column = index % 7;
          const shown = cell.slots.slice(0, MAX_SLOTS);
          const hidden = cell.entries.length - shown.filter(Boolean).length;
          const multiDay = cell.entries.filter((e) => e.multiDay).length;
          return (
            <button
              key={cell.dateKey}
              type="button"
              className={
                "calendar-cell" +
                (cell.isCurrentMonth ? "" : " outside-month") +
                (cell.isToday ? " is-today" : "") +
                (isSelected ? " is-selected" : "") +
                (cell.entries.length > 0 ? " has-reminders" : "")
              }
              onClick={() => {
                setSelectedDateKey(cell.dateKey);
                setListMode("day");
              }}
              aria-label={`${cell.dateKey}, ${cell.entries.length} reminders${multiDay ? `, ${multiDay} running across several days` : ""}`}
            >
              <div className="calendar-day-num">{cell.day}</div>
              <div className="calendar-cell-items">
                {shown.map((entry, lane) =>
                  entry ? (
                    <CalendarPill
                      key={`${entry.note.id}-${entry.start}`}
                      entry={entry}
                      column={column}
                      now={now}
                    />
                  ) : (
                    <div key={`gap-${lane}`} className="calendar-pill calendar-pill-spacer" aria-hidden="true">
                      <span className="calendar-pill-dot" />
                      <span className="calendar-pill-text">{"\u00a0"}</span>
                    </div>
                  ),
                )}
                {hidden > 0 && (
                  <div className="calendar-more">
                    +{hidden} more
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected Day / Filtered Reminders List */}
      <div className="calendar-details">
        <div className="calendar-details-header">
          <div className="calendar-tabs">
            <button
              type="button"
              className={"small-btn" + (listMode === "day" ? " active-tab" : "")}
              onClick={() => setListMode("day")}
            >
              Selected Day ({selectedDateKey}) · {dayReminders.length}
            </button>
            <button
              type="button"
              className={"small-btn" + (listMode === "all" ? " active-tab" : "")}
              onClick={() => setListMode("all")}
            >
              All Reminders ({filteredReminders.length})
            </button>
          </div>
          <button
            type="button"
            className="small-btn primary"
            onClick={() =>
              onQuickAddReminderForDate(
                defaultTimeForSelectedDate(),
                colorFilter === "all" ? DEFAULT_REMINDER_COLOR : colorFilter,
              )
            }
          >
            + Add Reminder for {selectedDateKey}
          </button>
        </div>

        {displayedReminders.length === 0 ? (
          <p className="muted center-text small calendar-empty">
            {listMode === "day"
              ? `No reminders on ${selectedDateKey}${colorFilter !== "all" ? ` with colour "${getReminderColor(colorFilter).label}"` : ""}.`
              : `No active reminders${colorFilter !== "all" ? ` with colour "${getReminderColor(colorFilter).label}"` : ""}.`}
          </p>
        ) : (
          <ul className="notes">
            {displayedReminders.map((rem) =>
              renderReminderCard(
                rem,
                rem.sectionId ? (sectionMap.get(rem.sectionId) ?? null) : null,
              ),
            )}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * One reminder inside a day cell. An event running across several days is
 * drawn as a segment per day that joins up with its neighbours into one bar
 * (its title on the first day, and again where a new week row starts).
 */
function CalendarPill({
  entry,
  column,
  now,
}: {
  entry: CalendarEntry;
  column: number;
  now: number;
}) {
  const rem = entry.note;
  const col = getReminderColor(rem.color);
  const title = itemTitle(rem);
  const where = rem.location ? ` · 📍 ${rem.location}` : "";

  if (!entry.multiDay) {
    return (
      <div
        className="calendar-pill"
        style={{ backgroundColor: col.bg, borderLeft: `3px solid ${col.hex}` }}
        title={`${title}${where}`}
      >
        <span className="calendar-pill-dot" style={{ backgroundColor: col.hex }} />
        <span className="calendar-pill-text">{truncate(title, 14)}</span>
      </div>
    );
  }

  // Joins only within a week row: at the row's edges the bar is cut square.
  const joinLeft = entry.continuesBefore && column !== 0;
  const joinRight = entry.continuesAfter && column !== 6;
  const showLabel = !entry.continuesBefore || column === 0;
  const span = formatSpanLabel(rem, now);
  return (
    <div
      className={
        "calendar-pill span" +
        (entry.continuesBefore ? " cont-before" : "") +
        (entry.continuesAfter ? " cont-after" : "") +
        (joinLeft ? " join-left" : "") +
        (joinRight ? " join-right" : "")
      }
      style={{
        backgroundColor: col.bg,
        borderLeft: entry.continuesBefore ? undefined : `3px solid ${col.hex}`,
      }}
      title={`${title}${span ? ` · ${span}` : ""}${where} · day ${entry.dayIndex + 1} of ${entry.dayCount}`}
    >
      <span
        className={"calendar-pill-dot" + (showLabel ? "" : " is-hidden")}
        style={{ backgroundColor: col.hex }}
      />
      <span className="calendar-pill-text">{showLabel ? title : "\u00a0"}</span>
    </div>
  );
}
