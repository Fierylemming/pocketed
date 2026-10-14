import { useRef, useState } from "react";
import {
  fromLocalInput,
  quickReminders,
  REPEAT_OPTIONS,
  toLocalInput,
  type RepeatId,
} from "@pocketed/shared";

export interface ReminderValue {
  /** Chosen time, or null for "no reminder". */
  at: number | null;
  /** Why the current choice can't be saved, or null when it can. */
  error: string | null;
  /** How the reminder repeats. Always "none" when there is no time. */
  repeat: RepeatId;
}

const NONE: ReminderValue = { at: null, error: null, repeat: "none" };

const CUSTOM = "custom";
const NONE_ID = "none";

/**
 * Reminder chooser: quick presets or an exact date and time, plus how often it
 * repeats. Reports its validity through `error` so the parent can block saving
 * a bad time.
 */
export function ReminderPicker({
  initial,
  initialRepeat = "none",
  onChange,
  allowNone = true,
}: {
  initial: number | null;
  initialRepeat?: RepeatId;
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
  const [repeat, setRepeat] = useState<RepeatId>(
    initial == null ? "none" : initialRepeat,
  );
  // Keeps the last presentation-independent choice so repeat changes can re-emit it.
  const presetAt = useRef<number | null>(null);

  function valueFor(c: string, text: string, r: RepeatId): ReminderValue {
    if (c === NONE_ID) return NONE;
    if (c === CUSTOM) return { ...validateCustom(text), repeat: r };
    const at = presetAt.current ?? quickReminders(Date.now()).find((q) => q.id === c)?.at ?? null;
    return { at, error: null, repeat: r };
  }

  function presetTime(id: string): number | null {
    return quickReminders(Date.now()).find((q) => q.id === id)?.at ?? null;
  }

  function pick(id: string) {
    setChoice(id);
    if (id === NONE_ID) {
      presetAt.current = null;
      return onChange(NONE);
    }
    if (id === CUSTOM) {
      presetAt.current = null;
      const fallback = quickReminders(Date.now())[1].at; // "In 1 hour"
      const value = custom || toLocalInput(fallback);
      setCustom(value);
      return onChange(valueFor(CUSTOM, value, repeat));
    }
    presetAt.current = presetTime(id);
    onChange({ at: presetAt.current, error: null, repeat });
  }

  function type(value: string) {
    setCustom(value);
    onChange(valueFor(CUSTOM, value, repeat));
  }

  function changeRepeat(r: RepeatId) {
    setRepeat(r);
    onChange(valueFor(choice, custom, r));
  }

  const showRepeat = choice !== NONE_ID;

  return (
    <div className="reminder-picker">
      <div className="reminder-picker-row">
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
      {showRepeat && (
        <div className="reminder-picker-row">
          <label className="repeat-field">
            <span className="repeat-label">Repeat</span>
            <select
              value={repeat}
              onChange={(e) => changeRepeat(e.target.value as RepeatId)}
              aria-label="Repeat"
            >
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function validateCustom(value: string): Omit<ReminderValue, "repeat"> {
  const at = fromLocalInput(value);
  if (at == null) return { at: null, error: "Pick a date and time." };
  if (at <= Date.now()) return { at: null, error: "That time has already passed." };
  return { at, error: null };
}
