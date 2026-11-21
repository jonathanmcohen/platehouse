// The Activity page's Recent events list (the maintainer, 2026-11-19): newest first,
// at most the server's limit, built only from what the app records (models
// added, inbox files that failed, estimates, renders and conversions that
// failed). A live model is a link to its page; a trashed one is named
// without a link. A failed estimate has the model page's own retry, through
// the existing POST /app/api/estimates/:id/retry. Every text here is shown as
// text, never HTML, and the server has already taken paths and addresses
// out of it (scrubText and scrubDetail in apps/server/src/scrub.ts).

import { useState } from "react";
import { Link } from "react-router";
import { type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { ESTIMATE_REASON_KEYS, serverText } from "../i18n/serverText";
import { derivedMessageIn } from "../model/FilesTab";
import { appApi, segment } from "../settings/api";
import type { ActivityEvent, ModelSource } from "./ActivityPage";

const SOURCE_WORDS: Readonly<Record<ModelSource, MessageKey>> = {
  api: "activity.source.api",
  upload: "activity.source.upload",
  unknown: "activity.source.unknown",
};

/**
 * The words for each fixed reason an inbox file goes to failed with, by the
 * code its reason file starts with (apps/server/src/inbox/watch.ts). A
 * reason that quotes an error has no fixed words and is shown as it is. A
 * duplicate names its model, so it is said by inboxReasonIn below.
 */
const INBOX_REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  changed: "inbox.reason.changed",
  unconfirmed: "inbox.reason.unconfirmed",
  unremoved: "inbox.reason.unremoved",
  unchecked: "inbox.reason.unchecked",
  swapped: "inbox.reason.swapped",
  put_back_failed: "inbox.reason.putBackFailed",
  still_writing: "inbox.reason.stillWriting",
  held: "inbox.reason.held",
  non_utf8: "inbox.reason.nonUtf8",
  too_large: "inbox.reason.tooLarge",
  unsupported_type: "upload.result.unsupportedType",
  model_not_found: "upload.result.modelNotFound",
};

/** A reason in the shown language: by its code on a page in another language, else as the server wrote it. */
function reasonIn(
  i18n: Pick<I18n, "t" | "locale">,
  keys: Readonly<Record<string, MessageKey>>,
  code: string | null | undefined,
  words: string,
): string {
  return serverText(i18n, words, code === null || code === undefined ? undefined : keys[code]);
}

/**
 * An inbox file's reason in the shown language: a duplicate in the catalog's
 * words with the model the server read back from its sentence, any other by
 * its code; else as the server wrote it.
 */
export function inboxReasonIn(
  i18n: Pick<I18n, "t" | "locale">,
  event: {
    reason: string;
    reasonCode?: string | null;
    duplicate?: { name: string; id: string; others: number };
  },
): string {
  if (event.reasonCode === "duplicate" && event.duplicate !== undefined) {
    const { name, id, others } = event.duplicate;
    return serverText(i18n, event.reason, "inbox.reason.duplicate", { name, id, others });
  }
  return reasonIn(i18n, INBOX_REASON_KEYS, event.reasonCode, event.reason);
}

function When({ at }: { at: string }) {
  const { fmt } = useI18n();
  return (
    <time dateTime={at} className="studio-muted">
      {fmt.date(at, true)}
    </time>
  );
}

function ModelLink({ model }: { model: { id: string; name: string; trashed?: boolean } }) {
  const { t } = useI18n();
  if (model.trashed) return <span>{t("activity.trashedModel", { name: model.name })}</span>;
  return <Link to={`/models/${segment(model.id)}`}>{model.name}</Link>;
}

function EstimateFailure({
  event,
  onRetried,
}: {
  event: Extract<ActivityEvent, { type: "estimate_failed" }>;
  onRetried: () => void;
}) {
  const i18n = useI18n();
  const { t, rich } = i18n;
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
      setError(t("model.numbers.retryFailed"));
    } finally {
      setRetrying(false);
    }
  }

  const plate =
    event.plate.name === null
      ? t("activity.plate", { index: event.plate.index })
      : t("activity.plateNamed", { index: event.plate.index, name: event.plate.name });
  return (
    <>
      <div className="studio-row">
        <strong>{t("activity.event.estimateFailed")}</strong>
        <When at={event.at} />
      </div>
      <p className="ph-activity-line">
        {rich(
          "activity.onModel",
          { what: plate },
          { model: () => <ModelLink model={event.model} /> },
        )}
      </p>
      <p className="ph-activity-line">
        {reasonIn(i18n, ESTIMATE_REASON_KEYS, event.reasonCode, event.reason)}
        {event.code === null ? null : (
          <span className="studio-muted"> {t("activity.code", { code: event.code })}</span>
        )}
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
          {t("model.numbers.retry")}
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
  const i18n = useI18n();
  const { t, rich } = i18n;
  switch (event.type) {
    case "model_imported":
      return (
        <>
          <div className="studio-row">
            <strong>{t("activity.event.modelAdded")}</strong>
            <When at={event.at} />
          </div>
          <p className="ph-activity-line">
            <ModelLink model={event.model} />
          </p>
          <p className="ph-activity-line studio-muted">{t(SOURCE_WORDS[event.source])}</p>
        </>
      );
    case "inbox_failed":
      return (
        <>
          <div className="studio-row">
            <strong>{t("activity.event.inboxFailed")}</strong>
            <When at={event.at} />
          </div>
          <p className="ph-activity-line">{event.name}</p>
          <p className="ph-activity-line ph-activity-detail studio-muted">
            {inboxReasonIn(i18n, event)}
          </p>
        </>
      );
    case "estimate_failed":
      return <EstimateFailure event={event} onRetried={onChanged} />;
    case "render_failed":
      return (
        <>
          <div className="studio-row">
            <strong>
              {event.kind === "scad"
                ? t("activity.event.renderFailed")
                : t("activity.event.conversionFailed")}
            </strong>
            <When at={event.at} />
          </div>
          <p className="ph-activity-line">
            {rich(
              "activity.onModel",
              { what: event.file.name },
              { model: () => <ModelLink model={event.model} /> },
            )}
          </p>
          {event.message === null ? null : (
            <p className="ph-activity-line ph-activity-detail studio-muted">
              {derivedMessageIn(i18n, {
                derivedMessage: event.message,
                ...(event.messageCodes === undefined ? {} : { derivedCodes: event.messageCodes }),
                ...(event.messageDetail === undefined
                  ? {}
                  : { derivedDetail: event.messageDetail }),
              })}
            </p>
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
  const { t } = useI18n();
  return (
    <>
      {inboxReadable ? null : (
        <p className="studio-alert studio-alert-alert">{t("activity.inboxUnreadable")}</p>
      )}
      {items.length === 0 ? (
        <p className="studio-empty">{t("activity.noEvents")}</p>
      ) : (
        <ol className="studio-list ph-activity-events">
          {items.map((event) => (
            <li key={`${event.type}:${keyOf(event)}`} className="studio-list-item">
              <EventBody event={event} onChanged={onChanged} />
            </li>
          ))}
        </ol>
      )}
      <p className="studio-muted ph-activity-note">{t("activity.eventsNote", { limit })}</p>
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
