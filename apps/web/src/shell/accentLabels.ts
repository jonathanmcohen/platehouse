// Every word the accent colour feature shows, in one place, for the
// translations to replace (Jon, 2026-11-19). The scheme names are the ones
// Jon gave; each is also the accessible name of its swatch in the picker.
import type { AccentId } from "./accent";

export const ACCENT_NAMES: Readonly<Record<AccentId, string>> = {
  "bambu-green": "Green",
  "workshop-green": "Workshop green",
  "filament-orange": "Filament orange",
  "spool-teal": "Spool teal",
  "blueprint-indigo": "Blueprint indigo",
  "pla-violet": "PLA violet",
  coral: "Coral",
  amber: "Amber",
  "sky-blue": "Sky blue",
  magenta: "Magenta",
  graphite: "Graphite",
  lime: "Lime",
};

export const ACCENT_LABELS = {
  /** The Settings section's heading, which also names the radio group. */
  heading: "Accent colour",
  /** The sentence under the heading. */
  intro:
    "The colour of buttons, links and highlights. It applies at once and is kept in this browser.",
  /** The preview's sample button, link text and chip. */
  previewButton: "Button",
  previewLink: "Link text",
  previewChip: "Selected",
} as const;
