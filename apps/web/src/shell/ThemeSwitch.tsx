// Dark / Light / System (build plan Task 18, AC-070): three buttons in a
// fieldset named Theme, the current choice marked aria-pressed. A press
// switches at once with no reload; Shell writes the cookie and the html
// attribute (theme.ts).
import { type MessageKey, useI18n } from "../i18n/I18n";
import { THEMES, type Theme } from "./theme";

const LABELS: Record<Theme, MessageKey> = {
  dark: "shell.theme.dark",
  light: "shell.theme.light",
  system: "shell.theme.system",
};

export interface ThemeSwitchProps {
  theme: Theme;
  onChange(theme: Theme): void;
}

export function ThemeSwitch({ theme, onChange }: ThemeSwitchProps) {
  const { t } = useI18n();
  return (
    <fieldset className="studio-theme-switch">
      <legend className="studio-visually-hidden">{t("shell.theme.legend")}</legend>
      {THEMES.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={value === theme}
          onClick={() => onChange(value)}
        >
          {t(LABELS[value])}
        </button>
      ))}
    </fieldset>
  );
}
