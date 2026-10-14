import { setTheme, useTheme, type ThemePreference } from "../theme";
import { Icon, type IconName } from "./Icon";

const options: { value: ThemePreference; label: string; icon: IconName }[] = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
];
export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();
  return <div className={"theme-picker" + (compact ? " compact" : "")} role="group" aria-label="Colour theme">
    {options.map(({ value, label, icon }) => <button key={value} type="button" aria-pressed={theme === value} title={`${label} theme`} onClick={() => setTheme(value)}><Icon name={icon} /><span>{label}</span></button>)}
  </div>;
}
