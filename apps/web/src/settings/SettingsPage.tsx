// The Settings page, /settings (build plan Task 21; AC-013 warning, AC-031
// menu UI, AC-083 UI, AC-063 UI). It holds, in order: the red banner when
// bucket versioning is not on, My printers (PrinterMenu), the API tokens,
// Model names (the one-off "Use file titles", TitleNames.tsx), and the trash.
// Everything comes from the session-class app API under /app/api
// (apps/server/src/app-api); every dialog is the app's own themed one.
// The Accent colour picker (Jon, 2026-11-19) comes first: it is this
// browser's choice, kept in a cookie, and needs nothing from the API.
//
// /settings?view=api is the API reference (../api-docs), linked from the API
// tokens section. It is a view of this page rather than a path of its own,
// so it is served, and needs a login, exactly as /settings does. Its module
// and the OpenAPI document it bundles load only when it is opened. Switching
// view by a link moves focus to the new view's heading, since the link that
// was followed goes away and the shell only moves focus when the path
// changes; Back and Forward (a POP) and a fresh load leave focus alone.
import { lazy, Suspense, useEffect, useRef } from "react";
import { useNavigationType, useSearchParams } from "react-router";
import { TrashList } from "../trash/TrashList";
import { AccentPicker } from "./AccentPicker";
import { LanguagePicker } from "../i18n/LanguagePicker";
import { useI18n } from "../i18n/I18n";
import { useAppApi } from "./api";
import { PrinterMenu } from "./PrinterMenu";
import { TitleNames } from "./TitleNames";
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
  /**
   * Slices that run up to and including its last waiting one, other
   * printers' queued work counted (the slicer is one queue); 0 with none.
   */
  through: number;
}

/** What GET /app/api/settings answers. */
export interface SettingsView {
  /** The default printer. */
  printerId: string;
  /**
   * The version of My printers and the default together; every save sends
   * back the one the page read, and the server refuses an older one (409).
   */
  printersVersion: number;
  /** My printers, in order. */
  myPrinters: MyPrinterView[];
  /** The slicer's printer menu; null while the slicer cannot be asked. */
  printers: PrinterGroup[] | null;
  /** Plates the slicer estimates a minute, for "this takes about". */
  slicesPerMinute: number;
  bucketVersioning: BucketVersioning;
}

/** The view= value that shows the API reference (Tokens.tsx links to /settings?view=api). */
export const API_VIEW = "api";

const ApiReference = lazy(() => import("../api-docs/ApiReference"));

export function SettingsPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  // A link changed the view: the new view's heading takes focus.
  const focusHeading = useNavigationType() !== "POP";
  if (params.get("view") === API_VIEW) {
    return (
      <Suspense fallback={<p className="studio-muted">{t("settings.loadingReference")}</p>}>
        <ApiReference focusHeading={focusHeading} />
      </Suspense>
    );
  }
  return <SettingsMain focusHeading={focusHeading} />;
}

function SettingsMain({ focusHeading }: { focusHeading: boolean }) {
  const { t } = useI18n();
  const settings = useAppApi<SettingsView>("/settings");
  const heading = useRef<HTMLHeadingElement>(null);

  // Once, when the view appears; see the top of this file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount.
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, []);

  return (
    <>
      <div className="studio-page-head">
        <h1 ref={heading} tabIndex={-1}>
          {t("shell.nav.settings")}
        </h1>
      </div>
      <AccentPicker />
      <LanguagePicker />
      {settings.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{settings.error}</p>
      )}
      {settings.data === undefined ? (
        settings.error === undefined ? (
          <p className="studio-muted">{t("settings.loading")}</p>
        ) : null
      ) : (
        <>
          <VersioningBanner state={settings.data.bucketVersioning} />
          <div className="ph-section">
            <h2>{t("settings.myPrinters")}</h2>
            <PrinterMenu view={settings.data} reload={settings.reload} />
          </div>
        </>
      )}
      <Tokens />
      <TitleNames />
      <div className="ph-section">
        <h2>{t("shell.nav.trash")}</h2>
        <TrashList />
      </div>
    </>
  );
}
