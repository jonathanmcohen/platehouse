// The Activity page, /activity (Jon, 2026-11-19: one page that shows what
// Platehouse is doing and holds, so he never has to read container logs).
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
import { useCallback, useEffect, useId, useState } from "react";
import { AppApiError, appApi, formatDate } from "../settings/api";
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
  | { type: "inbox_failed"; at: string; name: string; reason: string }
  | {
      type: "estimate_failed";
      at: string;
      estimateId: string;
      model: { id: string; name: string };
      plate: { index: number; name: string | null };
      code: number | null;
      reason: string;
      detail: string | null;
    }
  | {
      type: "render_failed";
      at: string;
      kind: "scad" | "step";
      model: { id: string; name: string };
      file: { id: string; name: string };
      message: string | null;
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
    printerId: string;
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
    printerId: string;
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section className="ph-section ph-activity-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

function Library({ library }: { library: ActivityView["library"] }) {
  const empty = library.models.live + library.models.trashed === 0;
  return (
    <Section title="Library">
      {empty ? (
        <p className="studio-empty">
          The library is empty. Add files with Add, or put them in the inbox folder.
        </p>
      ) : null}
      <dl className="ph-activity-stats">
        <Stat label="Models" value={formatCount(library.models.live)} />
        <Stat label="In the trash" value={formatCount(library.models.trashed)} />
        <Stat label="Plates" value={formatCount(library.plates)} />
        <Stat label="3MF files" value={formatCount(library.files["3mf"])} />
        <Stat label="STL files" value={formatCount(library.files.stl)} />
        <Stat label="STEP files" value={formatCount(library.files.step)} />
        <Stat label="SCAD files" value={formatCount(library.files.scad)} />
        <Stat label="Stored objects" value={formatCount(library.blobs.count)} />
        <Stat label="Stored size" value={formatSize(library.blobs.bytes)} />
        <Stat
          label="Last import"
          value={library.lastImportAt === null ? "Never" : formatDate(library.lastImportAt, true)}
        />
      </dl>
    </Section>
  );
}

function rateWords(e: ActivityView["estimates"]): string {
  const left = e.pending + e.running;
  if (e.total === 0) return "No estimates for this printer yet.";
  if (left === 0) {
    return e.perMinute === null
      ? "Nothing is waiting."
      : `Nothing is waiting. About ${formatRate(e.perMinute)} plates a minute recently.`;
  }
  if (e.perMinute === null || e.secondsLeft === null) {
    return "Not enough recent progress to estimate the time left.";
  }
  return `About ${formatRate(e.perMinute)} plates a minute; roughly ${formatDuration(e.secondsLeft)} left.`;
}

function Estimates({ estimates }: { estimates: ActivityView["estimates"] }) {
  const labelId = useId();
  const settled = estimates.done + estimates.failed;
  const percent = estimates.total === 0 ? 0 : Math.round((settled / estimates.total) * 100);
  return (
    <Section title="Estimates">
      <p id={labelId}>
        Estimates for {estimates.printerId}
        {estimates.orcaVersion === null ? null : ` with OrcaSlicer ${estimates.orcaVersion}`}
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
            aria-valuetext={`${settled} of ${estimates.total} plates settled`}
          >
            <div className="ph-activity-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="studio-muted">
            {formatCount(settled)} of {formatCount(estimates.total)} plates settled ({percent}%),
            counting failures.
          </p>
        </>
      )}
      <dl className="ph-activity-stats">
        <Stat label="Done" value={formatCount(estimates.done)} />
        <Stat label="Waiting" value={formatCount(estimates.pending)} />
        <Stat label="Slicing" value={formatCount(estimates.running)} />
        <Stat label="Failed" value={formatCount(estimates.failed)} />
      </dl>
      <p>{rateWords(estimates)}</p>
    </Section>
  );
}

function Queues({ queues }: { queues: QueueRow[] }) {
  return (
    <Section title="Queues">
      <table className="ph-activity-table">
        <caption className="studio-visually-hidden">
          Background jobs by queue: waiting, running and failed
        </caption>
        <thead>
          <tr>
            <th scope="col">Queue</th>
            <th scope="col">Waiting</th>
            <th scope="col">Running</th>
            <th scope="col">Failed</th>
          </tr>
        </thead>
        <tbody>
          {queues.map((q) => (
            <tr key={q.id}>
              <th scope="row">{q.label}</th>
              <td>{formatCount(q.waiting)}</td>
              <td>{formatCount(q.active)}</td>
              <td>{formatCount(q.failed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="studio-muted ph-activity-note">
        Failed jobs are kept for 7 days. A failed estimate or render is also listed under Recent
        events.
      </p>
    </Section>
  );
}

function lastRunWords(s: ScheduleRow): string {
  if (s.lastRunAt === null) return "No run recorded in the last 7 days";
  const how = s.lastState === "failed" ? "failed" : "finished";
  return `Last ran ${formatDate(s.lastRunAt, true)}, ${how}`;
}

function Schedules({ schedules }: { schedules: ScheduleRow[] }) {
  return (
    <Section title="Scheduled jobs">
      {schedules.length === 0 ? (
        <p className="studio-empty">No scheduled jobs are registered.</p>
      ) : (
        <ul className="studio-list">
          {schedules.map((s) => (
            <li key={s.key} className="studio-list-item">
              <div className="studio-row">
                <strong>{s.label}</strong>
                <span className="studio-muted">{s.schedule}</span>
              </div>
              <p
                className={
                  s.lastState === "failed"
                    ? "ph-activity-line ph-activity-error"
                    : "ph-activity-line"
                }
              >
                {lastRunWords(s)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Slicer({ slicer }: { slicer: ActivityView["slicer"] }) {
  const status = !slicer.reachable
    ? "Not reachable"
    : slicer.busy
      ? "Reachable, slicing now"
      : "Reachable, idle";
  return (
    <Section title="Slicer">
      {slicer.reachable ? null : (
        <p className="studio-alert studio-alert-alert">
          The slicer is not answering. Estimates and renders wait until it is back.
        </p>
      )}
      <dl className="studio-dl">
        <dt>Status</dt>
        <dd>{status}</dd>
        <dt>OrcaSlicer</dt>
        <dd>{slicer.orca ?? "Unknown"}</dd>
        <dt>OpenSCAD</dt>
        <dd>{slicer.openscad ?? "Unknown"}</dd>
        <dt>Selected printer</dt>
        <dd>{slicer.printerId}</dd>
      </dl>
    </Section>
  );
}

// ---- The page ----

export function ActivityPage() {
  const { view, problem, refresh } = useActivity();

  return (
    <>
      <div className="studio-page-head">
        <h1>Activity</h1>
        <div className="ph-activity-head">
          {view === undefined ? null : (
            <span className="studio-muted">Updated {formatDate(view.generatedAt, true)}</span>
          )}
          <button type="button" className="studio-button ph-small" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>
      {problem === "signed-out" ? (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>You are signed out. Reload the page to sign in again.</p>
        </div>
      ) : problem === "failed" ? (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>
            {view === undefined
              ? "The activity could not be loaded right now."
              : "The activity could not be refreshed right now. What is shown may be out of date."}
          </p>
          <button type="button" className="studio-button" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}
      {view === undefined ? (
        problem === null ? (
          <p className="studio-muted">Loading the activity.</p>
        ) : null
      ) : (
        <>
          <Library library={view.library} />
          <Estimates estimates={view.estimates} />
          <Queues queues={view.queues} />
          <Schedules schedules={view.schedules} />
          <Slicer slicer={view.slicer} />
          <Section title="Recent events">
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
