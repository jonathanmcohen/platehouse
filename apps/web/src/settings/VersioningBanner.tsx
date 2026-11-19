// The bucket versioning warning on the settings page (build plan Task 21;
// AC-013, decided Q20). The server reads the bucket's versioning state at
// startup (apps/server/src/app-api/settings.ts, recordVersioning). While
// versioning is not on, off or suspended, the page shows a red banner with
// the plan's exact sentence. When the state could not be read (unknown) it
// says so in a quiet line instead, since it cannot claim versioning is off.
import type { BucketVersioning } from "./SettingsPage";
import { ENGLISH_I18N, useI18n } from "../i18n/I18n";

/** The red banner's words when bucket versioning is not on (the plan's exact sentence). */
export const VERSIONING_OFF_WARNING = ENGLISH_I18N.t("settings.versioning.off");

export function VersioningBanner({ state }: { state: BucketVersioning }) {
  const { t } = useI18n();
  if (state === "off" || state === "suspended") {
    return (
      <p role="alert" className="studio-alert studio-alert-alert">
        {t("settings.versioning.off")}
      </p>
    );
  }
  if (state === "unknown") {
    return (
      <p className="studio-muted">
        {t("settings.versioning.unknown")}
      </p>
    );
  }
  return null;
}
