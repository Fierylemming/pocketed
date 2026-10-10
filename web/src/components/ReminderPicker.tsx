import { useState } from "react";
import { fromLocalInput, quickReminders, toLocalInput } from "@pocketed/shared";

export interface ReminderValue {
  /** Chosen time, or null for "no reminder". */
  at: number | null;
  /** Why the current choice can't be saved, or null when it can. */
  error: string | null;
}

const NONE: ReminderValue = { at: null, error: null };

const CUSTOM = "custom";
const NONE_ID = "none";

/**
 * Reminder chooser: quick presets, or an exact date and time. Reports its
 * validity through `error` so the parent can block saving a bad time.
 */
export function ReminderPicker({
  initial,
  onChange,
  allowNone = true,
}: {
  initial: number | null;
  onChange: (v: ReminderValue) => void;
  allowNone?: boolean;
}) {
  const [choice, setChoice] = useState<string>(() => {
    if (initial != null) return CUSTOM;
    return allowNone ? NONE_ID : "1h";
  });
  const [custom, setCustom] = useState(
    initial == null ? "" : toLocalInput(initial),
  );

  function pick(id: string) {
    setChoice(id);
    if (id === NONE_ID) return onChange(NONE);
    if (id === CUSTOM) {
      const fallback = quickReminders(Date.now())[1].at; // "In 1 hour"
      const value = custom || toLocalInput(fallback);
      setCustom(value);
      return onChange(validateCustom(value));
    }
    const at = quickReminders(Date.now()).find((q) => q.id === id)?.at ?? null;
    onChange({ at, error: null });
  }

  function type(value: string) {
    setCustom(value);
    onChange(validateCustom(value));
  }

  return (
    <div className="reminder-picker">
      <select
        value={choice}
        onChange={(e) => pick(e.target.value)}
        aria-label="Reminder"
      >
        {allowNone && <option value={NONE_ID}>No reminder</option>}
        {quickReminders(Date.now()).map((q) => (
          <option key={q.id} value={q.id}>
            {q.label}
          </option>
        ))}
        <option value={CUSTOM}>Pick a date & time…</option>
      </select>
      {choice === CUSTOM && (
        <input
          type="datetime-local"
          aria-label="Reminder date and time"
          value={custom}
          onChange={(e) => type(e.target.value)}
        />
      )}
    </div>
  );
}

function validateCustom(value: string): ReminderValue {
  const at = fromLocalInput(value);
  if (at == null) return { at: null, error: "Pick a date and time." };
  if (at <= Date.now()) return { at: null, error: "That time has already passed." };
  return { at, error: null };
}
