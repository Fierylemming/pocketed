import { getReminderColor, type ReminderColorId } from "@pocketed/shared";
import { colorPickerChoices } from "../view-model";

/**
 * Colour chooser for a reminder: Google Calendar's palette as a grid of round
 * swatches — the same shape as Google's own colour picker — with the chosen
 * colour named beside them, since 24 names at once would swamp the composer.
 *
 * `original` is the colour the item already has; it stays on offer even when
 * it's a shade Google's palette doesn't include (a custom colour from Google's
 * picker, or one of Pocketed's six retired names).
 */
export function ColorPicker({
  value,
  original,
  onChange,
  showName = true,
  ariaLabel = "Reminder colour",
}: {
  value: ReminderColorId;
  original?: ReminderColorId | null;
  onChange: (color: ReminderColorId) => void;
  showName?: boolean;
  ariaLabel?: string;
}) {
  const selected = getReminderColor(value);
  const choices = colorPickerChoices(original ?? value);
  return (
    <div className="color-picker-row">
      <div className="color-swatch-grid" role="radiogroup" aria-label={ariaLabel}>
        {choices.map((c) => {
          const active = c.id === selected.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={c.label}
              title={c.label}
              className={"color-swatch" + (active ? " selected" : "")}
              style={{ backgroundColor: c.hex }}
              onClick={() => onChange(c.id)}
            />
          );
        })}
      </div>
      {showName && <span className="color-picker-name">{selected.label}</span>}
    </div>
  );
}
