// The Settings page, /settings (build plan Task 21; AC-013 warning, AC-031
// menu UI, AC-083 UI, AC-063 UI). It holds, in order: the red banner when
// bucket versioning is not on, the printer menu, the API tokens, and the
// trash. Everything comes from the session-class app API under /app/api
// (apps/server/src/app-api); every dialog is the app's own themed one.
import { TrashList } from "../trash/TrashList";
import { useAppApi } from "./api";
import { PrinterMenu } from "./PrinterMenu";
import { Tokens } from "./Tokens";
import { VersioningBanner } from "./VersioningBanner";
import "./organise.css";

export type BucketVersioning = "enabled" | "suspended" | "off" | "unknown";

/** One printer model in the menu, with its nozzle choices. */
export interface PrinterGroup {
  model: string;
  printers: Array<{ id: string; nozzle: number }>;
}

/** What GET /app/api/settings answers. */
export interface SettingsView {
  printerId: string;
  printers: PrinterGroup[] | null;
  bucketVersioning: BucketVersioning;
}

export function SettingsPage() {
  const settings = useAppApi<SettingsView>("/settings");

  return (
    <>
      <div className="studio-page-head">
        <h1>Settings</h1>
      </div>
      {settings.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{settings.error}</p>
      )}
      {settings.data === undefined ? (
        settings.error === undefined ? (
          <p className="studio-muted">Loading the settings.</p>
        ) : null
      ) : (
        <>
          <VersioningBanner state={settings.data.bucketVersioning} />
          <div className="ph-section">
            <h2>Printer</h2>
            <PrinterMenu printerId={settings.data.printerId} printers={settings.data.printers} />
          </div>
        </>
      )}
      <Tokens />
      <div className="ph-section">
        <h2>Trash</h2>
        <TrashList />
      </div>
    </>
  );
}
