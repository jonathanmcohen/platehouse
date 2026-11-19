// The Settings page, /settings (build plan Task 21; AC-013 warning, AC-031
// menu UI, AC-083 UI, AC-063 UI). It holds, in order: the red banner when
// bucket versioning is not on, My printers (PrinterMenu), the API tokens,
// and the trash. Everything comes from the session-class app API under /app/api
// (apps/server/src/app-api); every dialog is the app's own themed one.
// The Accent colour picker (Jon, 2026-11-19) comes first: it is this
// browser's choice, kept in a cookie, and needs nothing from the API.
import { TrashList } from "../trash/TrashList";
import { AccentPicker } from "./AccentPicker";
import { useAppApi } from "./api";
import { PrinterMenu } from "./PrinterMenu";
import { Tokens } from "./Tokens";
import { VersioningBanner } from "./VersioningBanner";
import "./organise.css";

export type BucketVersioning = "enabled" | "suspended" | "off" | "unknown";

/** One printer model in the menu, with its nozzle choices, each named in full. */
export interface PrinterGroup {
  model: string;
  printers: Array<{ id: string; nozzle: number; name: string }>;
}

/** One of My printers (apps/server/src/app-api/settings.ts MyPrinterView). */
export interface MyPrinterView {
  id: string;
  /** The printer in full, such as "Bambu Lab P1S, 0.4 mm nozzle". */
  name: string;
  /** Whether the slicer still offers it; null while the slicer cannot be asked. */
  offered: boolean | null;
  /** Plate estimates still waiting for it. */
  waiting: number;
}

/** What GET /app/api/settings answers. */
export interface SettingsView {
  /** The default printer. */
  printerId: string;
  /** My printers, in order. */
  myPrinters: MyPrinterView[];
  /** The slicer's printer menu; null while the slicer cannot be asked. */
  printers: PrinterGroup[] | null;
  /** Plates the slicer estimates a minute, for "this takes about". */
  slicesPerMinute: number;
  bucketVersioning: BucketVersioning;
}

export function SettingsPage() {
  const settings = useAppApi<SettingsView>("/settings");

  return (
    <>
      <div className="studio-page-head">
        <h1>Settings</h1>
      </div>
      <AccentPicker />
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
            <h2>My printers</h2>
            <PrinterMenu view={settings.data} reload={settings.reload} />
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
