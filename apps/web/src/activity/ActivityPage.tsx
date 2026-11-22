// The Activity page, /activity (the maintainer, 2026-11-19: one page that shows what
// Platehouse is doing and holds, so the user never has to read container logs).
// Everything comes from the session-class GET /app/api/activity
// (apps/server/src/app-api/activity.ts): the library's numbers, estimate
// progress for the selected printer as a labelled progressbar, the pg-boss
// queues and scheduled jobs, the slicer's health, and the newest events.
// No log line is shown anywhere; the server sends structured facts only.
//
// Refreshing: the page asks again every POLL_WORKING_MS while the answer
// says work is queued or running, and every POLL_IDLE_MS otherwise, so a new
// upload shows without a reload. It stops while the tab is hidden and asks
// at once when the tab is shown again. A failed refresh keeps the page on
// screen with a notice and keeps asking; a signed-out answer stops it, since
// asking again will not change that. Refresh asks at once.
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { printerNameIn } from "../i18n/printers";
import { serverText, serverTextWith } from "../i18n/serverText";
import { AppApiError, appApi } from "../settings/api";
import { Events } from "./Events";
import { formatCount, formatDuration, formatRate, formatSize } from "./format";
import "../settings/organise.css";
import "./activity.css";

/** How often the page asks again while work is queued or running. */
export const POLL_WORKING_MS = 5_000;

/** How often the page asks again when nothing is queued or running. */
export const POLL_IDLE_MS = 30_000;

// ---- What GET /app/api/activity answers (app-api/activity.ts ActivityView) ----

export type FileKind = "3mf" | "stl" | "step" | "scad";
export type ModelSource = "api" | "upload" | "unknown";

export interface QueueRow {
  id: string;
  label: string;
  waiting: number;
  active: number;
  failed: number;
}

export interface ScheduleRow {
  key: string;
  label: string;
  schedule: string;
  lastRunAt: string | null;
  lastState: "completed" | "failed" | null;
}

export type ActivityEvent =
  | {
      type: "model_imported";
      at: string;
      model: { id: string; name: string; trashed: boolean };
      source: ModelSource;
    }
  | {
      type: "inbox_failed";
      at: string;
      name: string;
      reason: string;
      /** The code the reason file starts with; null for an older file with none. */
      reasonCode?: string | null;
      /** For a duplicate: the model the reason names and how many others hold the file. */
      duplicate?: { name: string; id: string; others: number };
    }
  | {
      type: "estimate_failed";
      at: string;
      estimateId: string;
      model: { id: string; name: string };
      plate: { index: number; name: string | null };
      code: number | null;
      reason: string;
      /** The contract's reason (slicer_error, bed_too_small, ...), for the words in another language. */
      reasonCode?: string;
      detail: string | null;
    }
  | {
      /** The description re-conversion on upgrade (#357): what one run did. */
      type: "descriptions_reconverted";
      at: string;
      converter: number;
      checked: number;
      changed: number;
      unchanged: number;
      kept: number;
      unreadable: number;
    }
  | {
      type: "render_failed";
      at: string;
      /** preview: an STL's or a STEP file's preview picture (issue #316). */
      kind: "scad" | "step" | "preview";
      model: { id: string; name: string };
      file: { id: string; name: string };
      message: string | null;
      /** Platehouse's own sentences at the start of message, by code; absent from an older answer. */
      messageCodes?: string[];
      /** What message holds after those sentences. */
      messageDetail?: string | null;
    };

export interface ActivityView {
  generatedAt: string;
  library: {
    models: { live: number; trashed: number };
    files: Record<FileKind, number>;
    plates: number;
    blobs: { count: number; bytes: number };
    lastImportAt: string | null;
  };
  estimates: {
    /** The default printer of My printers, and its full name. */
    printerId: string;
    printerName: string;
    orcaVersion: string | null;
    done: number;
    pending: number;
    running: number;
    failed: number;
    total: number;
    perMinute: number | null;
    secondsLeft: number | null;
  };
  queues: QueueRow[];
  schedules: ScheduleRow[];
  slicer: {
    reachable: boolean;
    busy: boolean | null;
    orca: string | null;
    openscad: string | null;
    /** The default printer of My printers, and its full name. */
    printerId: string;
    printerName: string;
  };
  events: { items: ActivityEvent[]; limit: number; inboxReadable: boolean };
  working: boolean;
}

// ---- Loading and refreshing ----

type Problem = "failed" | "signed-out" | null;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** The newest answer, why the last ask failed (if it did), and a way to ask at once. */
function useActivity(): { view: ActivityView | undefined; problem: Problem; refresh(): void } {
  const [view, setView] = useState<ActivityView | undefined>(undefined);
  const [problem, setProblem] = useState<Problem>(null);
  const [asks, setAsks] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: asks is a trigger: Refresh, Try again and a retry ask again at once.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let working = false;
    let stopped = false;

    function stopTimer() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }

    function schedule() {
      stopTimer();
      if (cancelled || stopped || isHidden()) return;
      timer = setTimeout(load, working ? POLL_WORKING_MS : POLL_IDLE_MS);
    }

    async function load() {
      timer = undefined;
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const next = await appApi<ActivityView>("GET", "/activity");
        if (cancelled) return;
        working = next.working;
        setView(next);
        setProblem(null);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof AppApiError && error.status === 401) {
          stopped = true;
          setProblem("signed-out");
        } else {
          setProblem("failed");
        }
      } finally {
        inFlight = false;
        schedule();
      }
    }

    function onVisibility() {
      if (isHidden()) stopTimer();
      else if (!stopped) {
        stopTimer();
        void load();
      }
    }

    document.addEventListener("visibilitychange", onVisibility);
    void load();
    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [asks]);

  const refresh = useCallback(() => setAsks((n) => n + 1), []);
  return { view, problem, refresh };
}

// ---- Sections ----

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ph-activity-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ph-section ph-activity-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Library({ library }: { library: ActivityView["library"] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const count = (n: number) => formatCount(n, i18n);
  const empty = library.models.live + library.models.trashed === 0;
  return (
    <Section title={t("activity.library.title")}>
      {empty ? <p className="studio-empty">{t("activity.library.empty")}</p> : null}
      <dl className="ph-activity-stats">
        <Stat label={t("activity.library.models")} value={count(library.models.live)} />
        <Stat label={t("activity.library.trashed")} value={count(library.models.trashed)} />
        <Stat label={t("activity.library.plates")} value={count(library.plates)} />
        <Stat
          label={t("activity.library.files", { kind: "3MF" })}
          value={count(library.files["3mf"])}
        />
        <Stat
          label={t("activity.library.files", { kind: "STL" })}
          value={count(library.files.stl)}
        />
        <Stat
          label={t("activity.library.files", { kind: "STEP" })}
          value={count(library.files.step)}
        />
        <Stat
          label={t("activity.library.files", { kind: "SCAD" })}
          value={count(library.files.scad)}
        />
        <Stat label={t("activity.library.objects")} value={count(library.blobs.count)} />
        <Stat label={t("activity.library.size")} value={formatSize(library.blobs.bytes, i18n)} />
        <Stat
          label={t("activity.library.lastImport")}
          value={
            library.lastImportAt === null
              ? t("activity.library.never")
              : i18n.fmt.date(library.lastImportAt, true)
          }
        />
      </dl>
    </Section>
  );
}

function rateWords(e: ActivityView["estimates"], i18n: I18n): string {
  const { t } = i18n;
  const left = e.pending + e.running;
  if (e.total === 0) return t("activity.rate.none");
  if (left === 0) {
    return e.perMinute === null
      ? t("activity.rate.idle")
      : t("activity.rate.idleRecent", { rate: formatRate(e.perMinute, i18n) });
  }
  if (e.perMinute === null || e.secondsLeft === null) return t("activity.rate.unknown");
  return t("activity.rate.left", {
    rate: formatRate(e.perMinute, i18n),
    time: formatDuration(e.secondsLeft, i18n),
  });
}

function Estimates({ estimates }: { estimates: ActivityView["estimates"] }) {
  const labelId = useId();
  const settled = estimates.done + estimates.failed;
  // Rounded down, so 100% means every plate is settled (issue #238); the
  // product comes first so an exact percent is not 0.999... below itself.
  const percent = estimates.total === 0 ? 0 : Math.floor((settled * 100) / estimates.total);
  const i18n = useI18n();
  const { t } = i18n;
  const printer = printerNameIn(i18n, estimates.printerName);
  return (
    <Section title={t("activity.estimates.title")}>
      <p id={labelId}>
        {estimates.orcaVersion === null
          ? t("activity.estimates.for", { printer })
          : t("activity.estimates.forWith", { printer, version: estimates.orcaVersion })}
      </p>
      {estimates.total === 0 ? null : (
        <>
          <div
            className="ph-activity-progress"
            role="progressbar"
            aria-labelledby={labelId}
            aria-valuemin={0}
            aria-valuemax={estimates.total}
            aria-valuenow={settled}
            aria-valuetext={t("activity.estimates.valueText", { settled, total: estimates.total })}
          >
            <div className="ph-activity-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="studio-muted">
            {t("activity.estimates.settled", {
              settled: formatCount(settled, i18n),
              total: formatCount(estimates.total, i18n),
              percent: i18n.fmt.percent(percent),
            })}
          </p>
        </>
      )}
      <dl className="ph-activity-stats">
        <Stat label={t("activity.estimates.done")} value={formatCount(estimates.done, i18n)} />
        <Stat
          label={t("activity.estimates.waiting")}
          value={formatCount(estimates.pending, i18n)}
        />
        <Stat
          label={t("activity.estimates.slicing")}
          value={formatCount(estimates.running, i18n)}
        />
        <Stat label={t("activity.estimates.failed")} value={formatCount(estimates.failed, i18n)} />
      </dl>
      <p>{rateWords(estimates, i18n)}</p>
    </Section>
  );
}

/** The words for each queue row, by its id; the server's label otherwise. */
const QUEUE_KEYS: Readonly<Record<string, MessageKey>> = {
  ingest: "activity.queue.ingest",
  estimates: "activity.queue.estimates",
  renders: "activity.queue.renders",
  step: "activity.queue.step",
  scheduled: "activity.queue.scheduled",
  other: "activity.queue.other",
};

/** The words for each scheduled job, by its key; the server's label otherwise. */
const SCHEDULE_KEYS: Readonly<Record<string, MessageKey>> = {
  "purge-expired": "activity.schedule.purgeExpired",
  "sweep-orphans": "activity.schedule.sweepOrphans",
  "purge-sessions": "activity.schedule.purgeSessions",
  "sweep-uploads": "activity.schedule.sweepUploads",
  "poll-orca": "activity.schedule.pollOrca",
  "check-renders": "activity.schedule.checkRenders",
  "backfill-previews": "activity.schedule.backfillPreviews",
  "reconvert-descriptions": "activity.schedule.reconvertDescriptions",
};

/**
 * A schedule in the shown language. The server writes it in English
 * (apps/server/src/app-api/activity.ts scheduleText, then the time zone in
 * brackets); its three plain forms are written again here, and anything
 * else (a cron line it could not put in words) is shown as it is.
 */
export function scheduleIn(i18n: Pick<I18n, "t" | "locale">, schedule: string): string {
  return serverTextWith(i18n, schedule, () => {
    const m = /^(.*) \(([^()]+)\)$/.exec(schedule);
    if (m === null) return undefined;
    const [, when = "", zone = ""] = m;
    let every = /^Every (\d+) minutes$/.exec(when);
    if (every !== null) return i18n.t("activity.when.minutes", { count: Number(every[1]), zone });
    if (when === "Every hour") return i18n.t("activity.when.hour", { zone });
    every = /^Daily at (\d\d:\d\d)$/.exec(when);
    if (every !== null) return i18n.t("activity.when.daily", { time: every[1] as string, zone });
    return undefined;
  });
}

function Queues({ queues }: { queues: QueueRow[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <Section title={t("activity.queues.title")}>
      <table className="ph-activity-table">
        <caption className="studio-visually-hidden">{t("activity.queues.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("activity.queues.queue")}</th>
            <th scope="col">{t("activity.estimates.waiting")}</th>
            <th scope="col">{t("activity.queues.running")}</th>
            <th scope="col">{t("activity.estimates.failed")}</th>
          </tr>
        </thead>
        <tbody>
          {queues.map((q) => (
            <tr key={q.id}>
              <th scope="row">{serverText(i18n, q.label, QUEUE_KEYS[q.id])}</th>
              <td>{formatCount(q.waiting, i18n)}</td>
              <td>{formatCount(q.active, i18n)}</td>
              <td>{formatCount(q.failed, i18n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="studio-muted ph-activity-note">{t("activity.queues.note")}</p>
    </Section>
  );
}

function lastRunWords(s: ScheduleRow, i18n: I18n): string {
  if (s.lastRunAt === null) return i18n.t("activity.schedules.noRun");
  const at = i18n.fmt.date(s.lastRunAt, true);
  return s.lastState === "failed"
    ? i18n.t("activity.schedules.lastFailed", { at })
    : i18n.t("activity.schedules.lastFinished", { at });
}

function Schedules({ schedules }: { schedules: ScheduleRow[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <Section title={t("activity.queue.scheduled")}>
      {schedules.length === 0 ? (
        <p className="studio-empty">{t("activity.schedules.none")}</p>
      ) : (
        <ul className="studio-list">
          {schedules.map((s) => (
            <li key={s.key} className="studio-list-item">
              <div className="studio-row">
                <strong>{serverText(i18n, s.label, SCHEDULE_KEYS[s.key])}</strong>
                <span className="studio-muted">{scheduleIn(i18n, s.schedule)}</span>
              </div>
              <p
                className={
                  s.lastState === "failed"
                    ? "ph-activity-line ph-activity-error"
                    : "ph-activity-line"
                }
              >
                {lastRunWords(s, i18n)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Slicer({ slicer }: { slicer: ActivityView["slicer"] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const status = !slicer.reachable
    ? t("activity.slicer.down")
    : slicer.busy
      ? t("activity.slicer.busy")
      : t("activity.slicer.idle");
  return (
    <Section title={t("model.numbers.slicer")}>
      {slicer.reachable ? null : (
        <p className="studio-alert studio-alert-alert">{t("activity.slicer.notAnswering")}</p>
      )}
      <dl className="studio-dl">
        <dt>{t("activity.slicer.status")}</dt>
        <dd>{status}</dd>
        <dt>OrcaSlicer</dt>
        <dd>{slicer.orca ?? t("activity.slicer.unknown")}</dd>
        <dt>OpenSCAD</dt>
        <dd>{slicer.openscad ?? t("activity.slicer.unknown")}</dd>
        <dt>{t("activity.slicer.defaultPrinter")}</dt>
        <dd>{printerNameIn(i18n, slicer.printerName)}</dd>
      </dl>
    </Section>
  );
}

// ---- The page ----

export function ActivityPage() {
  const { view, problem, refresh } = useActivity();
  const { t, fmt } = useI18n();

  return (
    <>
      <div className="studio-page-head">
        <h1>{t("shell.nav.activity")}</h1>
        <div className="ph-activity-head">
          {view === undefined ? null : (
            <span className="studio-muted">
              {t("activity.updated", { at: fmt.date(view.generatedAt, true) })}
            </span>
          )}
          <button type="button" className="studio-button ph-small" onClick={refresh}>
            {t("activity.refresh")}
          </button>
        </div>
      </div>
      {problem === "signed-out" ? (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>{t("common.signedOut")}</p>
        </div>
      ) : problem === "failed" ? (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>{view === undefined ? t("activity.loadFailed") : t("activity.refreshFailed")}</p>
          <button type="button" className="studio-button" onClick={refresh}>
            {t("common.tryAgain")}
          </button>
        </div>
      ) : null}
      {view === undefined ? (
        problem === null ? (
          <p className="studio-muted">{t("activity.loading")}</p>
        ) : null
      ) : (
        <>
          <Library library={view.library} />
          <Estimates estimates={view.estimates} />
          <Queues queues={view.queues} />
          <Schedules schedules={view.schedules} />
          <Slicer slicer={view.slicer} />
          <Section title={t("activity.events.title")}>
            <Events
              items={view.events.items}
              limit={view.events.limit}
              inboxReadable={view.events.inboxReadable}
              onChanged={refresh}
            />
          </Section>
        </>
      )}
    </>
  );
}
