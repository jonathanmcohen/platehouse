// The bucket versioning warning on the settings page (build plan Task 21;
// AC-013, decided Q20). The server reads the bucket's versioning state at
// startup (apps/server/src/app-api/settings.ts, recordVersioning). While
// versioning is not on, off or suspended, the page shows a red banner with
// the plan's exact sentence. When the state could not be read (unknown) it
// says so in a quiet line instead, since it cannot claim versioning is off.
import type { BucketVersioning } from "./SettingsPage";

/** The red banner's words when bucket versioning is not on (the plan's exact sentence). */
export const VERSIONING_OFF_WARNING =
  "Bucket versioning is off. Turn it on at your storage provider and keep old versions for 30 days.";

export function VersioningBanner({ state }: { state: BucketVersioning }) {
  if (state === "off" || state === "suspended") {
    return (
      <p role="alert" className="studio-alert studio-alert-alert">
        {VERSIONING_OFF_WARNING}
      </p>
    );
  }
  if (state === "unknown") {
    return (
      <p className="studio-muted">
        Platehouse could not read the bucket's versioning state when it started, so it cannot say
        whether old versions are kept.
      </p>
    );
  }
  return null;
}
