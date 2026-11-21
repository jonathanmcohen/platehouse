// The one rule for text the server sends (the maintainer, 2026-11-19, PR 287 review):
// a message, label, reason or sentence the server wrote is shown as it is on
// an English page, never en.json's copy of it, so the two can never disagree
// there; on a page in another language it is shown in the catalog's words
// when the page knows them, and as the server wrote it otherwise. Every place
// in the web app that shows server text in the shown language goes through
// serverText or serverTextWith. A server test (apps/server/test/locales/
// mirror.test.ts) checks that each catalog message mirroring a server
// sentence still says the same thing in English, since this rule would
// otherwise hide a drift on English pages.
import { type MessageValues, SOURCE_LOCALE } from "@platehouse/i18n";
import type { I18n, MessageKey } from "./I18n";

type Words = Pick<I18n, "t" | "locale">;

/**
 * Server text in the shown language: sent on an English page; else the
 * catalog's words built by translate, or sent when translate has none.
 */
export function serverTextWith(
  i18n: Words,
  sent: string,
  translate: () => string | undefined,
): string {
  if (i18n.locale === SOURCE_LOCALE) return sent;
  return translate() ?? sent;
}

/** Server text in the shown language, by the catalog key standing for it (none: sent as it is). */
export function serverText(
  i18n: Words,
  sent: string,
  key: MessageKey | undefined,
  values: MessageValues = {},
): string {
  return serverTextWith(i18n, sent, () => (key === undefined ? undefined : i18n.t(key, values)));
}

/** The words for each reason a plate could not be sliced (the Slicer HTTP contract's reasons). */
export const ESTIMATE_REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  process_not_compatible: "estimate.reason.processNotCompatible",
  machine_not_supported: "estimate.reason.machineNotSupported",
  bed_too_small: "estimate.reason.bedTooSmall",
  nozzle_mismatch: "estimate.reason.nozzleMismatch",
  filament_temperature: "estimate.reason.filamentTemperature",
  toolpath_conflict: "estimate.reason.toolpathConflict",
  timeout: "estimate.reason.timeout",
  slicer_error: "estimate.reason.slicerError",
};
