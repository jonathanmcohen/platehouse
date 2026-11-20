// Every word the accent colour feature shows (Jon, 2026-11-19), by message
// key; the words themselves are in the catalogs (packages/i18n/locales). The
// scheme names are the ones Jon gave; each is also the accessible name of its
// swatch in the picker. ACCENT_NAMES and ACCENT_LABELS are the English words,
// for code and tests that need them outside a component.
import { ENGLISH_I18N, type MessageKey } from "../i18n/I18n";
import type { AccentId } from "./accent";

export const ACCENT_NAME_KEYS: Readonly<Record<AccentId, MessageKey>> = {
  "bambu-green": "accent.name.bambuGreen",
  "workshop-green": "accent.name.workshopGreen",
  "filament-orange": "accent.name.filamentOrange",
  "spool-teal": "accent.name.spoolTeal",
  "blueprint-indigo": "accent.name.blueprintIndigo",
  "pla-violet": "accent.name.plaViolet",
  coral: "accent.name.coral",
  amber: "accent.name.amber",
  "sky-blue": "accent.name.skyBlue",
  magenta: "accent.name.magenta",
  graphite: "accent.name.graphite",
  lime: "accent.name.lime",
};

export const ACCENT_LABEL_KEYS = {
  /** The Settings section's heading, which also names the radio group. */
  heading: "accent.heading",
  /** The sentence under the heading. */
  intro: "accent.intro",
  /** The preview's sample button, link text and chip. */
  previewButton: "accent.preview.button",
  previewLink: "accent.preview.link",
  previewChip: "accent.preview.chip",
} as const satisfies Record<string, MessageKey>;

/** The scheme names in English. */
export const ACCENT_NAMES: Readonly<Record<AccentId, string>> = Object.fromEntries(
  Object.entries(ACCENT_NAME_KEYS).map(([id, key]) => [id, ENGLISH_I18N.t(key)]),
) as Record<AccentId, string>;

/** The section's words in English. */
export const ACCENT_LABELS = Object.fromEntries(
  Object.entries(ACCENT_LABEL_KEYS).map(([name, key]) => [name, ENGLISH_I18N.t(key)]),
) as Record<keyof typeof ACCENT_LABEL_KEYS, string>;
