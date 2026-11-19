// The Accent colour section of Settings (Jon, 2026-11-19): twelve swatches
// as a radio group, following the WAI-ARIA radio group pattern. Only the
// checked swatch is in the tab order; Right and Down move to the next scheme,
// Left and Up to the previous one (wrapping), Home and End to the first and
// last, and moving checks the scheme it lands on. Each swatch is named by its
// scheme's name, shown beside the colour. A pick applies at once (data-accent
// and the ph_accent cookie, no reload), so the whole app is the live
// preview; the small sample row shows the button, link text, chip and
// progress bar in the scheme.
//
// Each colour dot carries its scheme's data-accent, and the stylesheet gives
// an element inside the page with its own data-accent that scheme's tokens
// in the current theme, so a dot shows exactly the fill the app would use.
import { type KeyboardEvent, useId, useRef } from "react";
import { useAccent } from "../shell/AccentContext";
import { ACCENTS, type AccentId } from "../shell/accent";
import { useI18n } from "../i18n/I18n";
import { ACCENT_LABEL_KEYS, ACCENT_NAME_KEYS } from "../shell/accentLabels";

/** Where a key moves from index, or null for a key the group leaves alone. */
function moveFor(key: string, index: number): number | null {
  const last = ACCENTS.length - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return index === last ? 0 : index + 1;
    case "ArrowLeft":
    case "ArrowUp":
      return index === 0 ? last : index - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

export function AccentPicker() {
  const { t } = useI18n();
  const { accent, setAccent } = useAccent();
  const headingId = useId();
  const introId = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = moveFor(event.key, index);
    if (next === null) return;
    event.preventDefault();
    setAccent(ACCENTS[next] as AccentId);
    buttons.current[next]?.focus();
  }

  return (
    <div className="ph-section">
      <h2 id={headingId}>{t(ACCENT_LABEL_KEYS.heading)}</h2>
      <p id={introId} className="studio-muted">
        {t(ACCENT_LABEL_KEYS.intro)}
      </p>
      <div
        className="ph-accent-picker"
        role="radiogroup"
        aria-labelledby={headingId}
        aria-describedby={introId}
      >
        {ACCENTS.map((id, index) => {
          const isChecked = id === accent;
          return (
            // biome-ignore lint/a11y/useSemanticElements: the WAI-ARIA radio group pattern (role="radio" with aria-checked and a roving tabindex) is what the brief asks for; it gives the same Home, End and wrapping arrow keys in every browser, which native radios do not, and test/accent-picker.test.tsx pins that behaviour.
            <button
              key={id}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={isChecked}
              tabIndex={isChecked ? 0 : -1}
              className="ph-accent-option"
              onClick={() => setAccent(id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="ph-accent-swatch" data-accent={id} aria-hidden="true" />
              <span className="ph-accent-name">{t(ACCENT_NAME_KEYS[id])}</span>
            </button>
          );
        })}
      </div>
      <div className="ph-accent-preview" aria-hidden="true">
        <span className="studio-button studio-button-primary">{t(ACCENT_LABEL_KEYS.previewButton)}</span>
        <span className="ph-accent-preview-link">{t(ACCENT_LABEL_KEYS.previewLink)}</span>
        <span className="studio-chip" aria-current="true">
          {t(ACCENT_LABEL_KEYS.previewChip)}
        </span>
        <progress className="ph-accent-preview-progress" value={60} max={100} />
      </div>
    </div>
  );
}
