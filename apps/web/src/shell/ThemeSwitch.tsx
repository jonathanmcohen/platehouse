// Dark / Light / System (build plan Task 18, AC-070): three buttons in a
// fieldset named Theme, the current choice marked aria-pressed. A press
// switches at once with no reload; Shell writes the cookie and the html
// attribute (theme.ts).
import { THEMES, type Theme } from "./theme";

const LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

export interface ThemeSwitchProps {
  theme: Theme;
  onChange(theme: Theme): void;
}

export function ThemeSwitch({ theme, onChange }: ThemeSwitchProps) {
  return (
    <fieldset className="studio-theme-switch">
      <legend className="studio-visually-hidden">Theme</legend>
      {THEMES.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={value === theme}
          onClick={() => onChange(value)}
        >
          {LABELS[value]}
        </button>
      ))}
    </fieldset>
  );
}
