// The Activity page's Recent events list (Jon, 2026-11-19): newest first,
// at most the server's limit, built only from what the app records (models
// added, inbox files that failed, estimates, renders and conversions that
// failed). A live model is a link to its page; a trashed one is named
// without a link. A failed estimate has the model page's own retry, through
// the existing POST /app/api/estimates/:id/retry. Every text here is shown as
// text, never HTML, and the server has already taken paths and addresses
// out of it (app-api/activity.ts scrubText).
import { useState } from "react";
import { Link } from "react-router";
import { appApi, formatDate, segment } from "../settings/api";
import type { ActivityEvent, ModelSource } from "./ActivityPage";

const SOURCE_WORDS: Readonly<Record<ModelSource, string>> = {
  api: "From the API",
  upload: "Uploaded (web or API)",
  unknown: "Source not recorded",
};

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} className="studio-muted">
      {formatDate(at, true)}
    </time>
  );
}

function ModelLink({ model }: { model: { id: string; name: string; trashed?: boolean } }) {
  if (model.trashed) return <span>{model.name} (in the trash)</span>;
  return <Link to={`/models/${segment(model.id)}`}>{model.name}</Link>;
}

function EstimateFailure({
  event,
  onRetried,
}: {
  event: Extract<ActivityEvent, { type: "estimate_failed" }>;
  onRetried: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    try {
      await appApi("POST", `/estimates/${segment(event.estimateId)}/retry`);
      onRetried();
    } catch {
      setError("This plate could not be retried right now. Try again later.");
    } finally {
      setRetrying(false);
    }
  }

  const plate =
    event.plate.name === null
      ? `plate ${event.plate.index}`
      : `plate ${event.plate.index} (${event.plate.name})`;
  return (
    <>
      <div className="studio-row">
        <strong>Estimate failed</strong>
        <When at={event.at} />
      </div>
      <p className="ph-activity-line">
        <ModelLink model={event.model} />, {plate}
      </p>
      <p className="ph-activity-line">
        {event.reason}
        {event.code === null ? null : <span className="studio-muted"> Code {event.code}</span>}
      </p>
      {event.detail === null ? null : (
        <p className="ph-activity-line ph-activity-detail studio-muted">{event.detail}</p>
      )}
      <div className="studio-actions">
        <button
          type="button"
          className="studio-button ph-small"
          aria-disabled={retrying}
          onClick={() => void retry()}
        >
          Retry
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="ph-activity-line ph-activity-error">
          {error}
        </p>
      )}
    </>
  );
}

function EventBody({ event, onChanged }: { event: ActivityEvent; onChanged: () => void }) {
  switch (event.type) {
    case "model_imported":
      return (
        <>
          <div className="studio-row">
            <strong>Model added</strong>
            <When at={event.at} />
          </div>
          <p className="ph-activity-line">
            <ModelLink model={event.model} />
          </p>
          <p className="ph-activity-line studio-muted">{SOURCE_WORDS[event.source]}</p>
        </>
      );
    case "inbox_failed":
      return (
        <>
          <div className="studio-row">
            <strong>Inbox file failed</strong>
            <When at={event.at} />
          </div>
          <p className="ph-activity-line">{event.name}</p>
          <p className="ph-activity-line ph-activity-detail studio-muted">{event.reason}</p>
        </>
      );
    case "estimate_failed":
      return <EstimateFailure event={event} onRetried={onChanged} />;
    case "render_failed":
      return (
        <>
          <div className="studio-row">
            <strong>
              {event.kind === "scad" ? "OpenSCAD render failed" : "STEP conversion failed"}
            </strong>
            <When at={event.at} />
          </div>
          <p className="ph-activity-line">
            <ModelLink model={event.model} />, {event.file.name}
          </p>
          {event.message === null ? null : (
            <p className="ph-activity-line ph-activity-detail studio-muted">{event.message}</p>
          )}
        </>
      );
  }
}

export interface EventsProps {
  items: readonly ActivityEvent[];
  limit: number;
  inboxReadable: boolean;
  /** Runs after a change made here (a retry), so the page asks again. */
  onChanged: () => void;
}

export function Events({ items, limit, inboxReadable, onChanged }: EventsProps) {
  return (
    <>
      {inboxReadable ? null : (
        <p className="studio-alert studio-alert-alert">
          The inbox's failed folder could not be read, so inbox failures may be missing here.
        </p>
      )}
      {items.length === 0 ? (
        <p className="studio-empty">No events yet.</p>
      ) : (
        <ol className="studio-list ph-activity-events">
          {items.map((event) => (
            <li key={`${event.type}:${keyOf(event)}`} className="studio-list-item">
              <EventBody event={event} onChanged={onChanged} />
            </li>
          ))}
        </ol>
      )}
      <p className="studio-muted ph-activity-note">
        Showing the newest {limit} events. Where a model came from is recorded only for models made
        through the API with an external reference and for uploads in the last 7 days; inbox imports
        and older uploads show as not recorded. Slicer restarts are not recorded; a slicer that was
        down shows in the failures it caused and in the Slicer section above.
      </p>
    </>
  );
}

function keyOf(event: ActivityEvent): string {
  switch (event.type) {
    case "model_imported":
      return event.model.id;
    case "inbox_failed":
      return `${event.name}:${event.at}`;
    case "estimate_failed":
      return event.estimateId;
    case "render_failed":
      return event.file.id;
  }
}
