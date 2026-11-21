// How the Activity page writes its numbers, in the shown language. The size
// and duration follow the same style as the Files tab and the library card,
// with the units from the catalog (packages/i18n/locales); English is the
// default, so the English page reads exactly as it did before translations.
import { ENGLISH_I18N, type I18n } from "../i18n/I18n";

type Words = Pick<I18n, "t" | "locale" | "fmt">;

/** A count with the digit grouping of the locale the page formats in (fmt.locale): 1,200. */
export function formatCount(n: number, i18n: Words = ENGLISH_I18N): string {
  return new Intl.NumberFormat(i18n.fmt.locale()).format(n);
}

/** A size: 684 B, 120.6 KB, 89.4 MB, 4.5 GB, 1.2 TB (powers of 1000, as the Files tab). */
export function formatSize(bytes: number, i18n: Words = ENGLISH_I18N): string {
  if (bytes < 1_000_000_000_000) return i18n.fmt.size(bytes);
  return i18n.t("format.size.terabytes", { value: i18n.fmt.decimal(bytes / 1_000_000_000_000, 2) });
}

/** A rough time left: 50m, 1h 25m, 2d 3h. Never less than 1m. */
export function formatDuration(seconds: number, i18n: Words = ENGLISH_I18N): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) {
    return i18n.t("format.duration.daysHours", { days: Math.floor(hours / 24), hours: hours % 24 });
  }
  return i18n.fmt.duration(seconds);
}

/** A rate: 2, 0.5, 12.25. */
export function formatRate(perMinute: number, i18n: Words = ENGLISH_I18N): string {
  return i18n.fmt.decimal(perMinute, 2);
}
