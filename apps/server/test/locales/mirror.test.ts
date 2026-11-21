// Catalog messages that mirror a server sentence must say the same thing
// (the maintainer, 2026-11-19, PR 287 review). The web app shows the server's own text
// on an English page and the catalog's words in any other language
// (apps/web/src/i18n/serverText.ts), so on an English page a drift between
// the two never shows; this test is what catches it. Each pair is a server
// constant and the en.json key the web app uses in its place.
import { readFileSync } from "node:fs";
import { englishPrinterName, formatMessage, OTHER_PRINTER_LABEL } from "@platehouse/i18n";
import { builtinLocalesDir } from "@platehouse/i18n/node";
import { describe, expect, test } from "vitest";
import { MAX_TOKEN_NAME_LENGTH } from "../../src/api/tokens.js";
import { ROW_LABELS, SCHEDULE_LABELS, scheduleText } from "../../src/app-api/activity.js";
import { PLAN_CHANGED_MESSAGE, TITLES_NOT_PREVIEWED_MESSAGE } from "../../src/app-api/model.js";
import {
  incompleteMessage,
  PURGE_STARTED_MESSAGE,
  STALE_TRASH,
} from "../../src/app-api/organise.js";
import {
  PRINTERS_CHANGED,
  SLICER_UNAVAILABLE_MESSAGE,
  UNKNOWN_PRINTER_MESSAGE,
} from "../../src/app-api/settings.js";
import { TOKEN_NAME_LENGTH_MESSAGE } from "../../src/app-api/tokens.js";
import { DERIVED_SENTENCES } from "../../src/derived/client.js";
import { REASON_WORDS } from "../../src/estimates/reasons.js";
import {
  CHANGED_REASON,
  HELD_REASON,
  NON_UTF8_REASON,
  PUT_BACK_FAILED_REASON,
  STILL_WRITING_REASON,
  SWAPPED_REASON,
  UNCHECKED_REASON,
  UNCONFIRMED_REASON,
  UNREMOVED_REASON,
} from "../../src/inbox/watch.js";
import { duplicateMessage } from "../../src/ingest/duplicates.js";
import {
  INGEST_FAILED_MESSAGE,
  MODEL_NOT_FOUND_MESSAGE,
  STORAGE_UNAVAILABLE_MESSAGE,
  UNSUPPORTED_MESSAGE,
} from "../../src/ingest/ingest.js";
import { MAINTENANCE_TASKS } from "../../src/jobs/queues.js";
import { UPLOAD_FAILED_MESSAGE } from "../../src/uploads/tus.js";

const EN = JSON.parse(readFileSync(`${builtinLocalesDir()}/en.json`, "utf8")) as Record<
  string,
  string
>;

/** The English message of a key, formatted; fails loudly for a key en.json lacks. */
function en(key: string, values: Record<string, string | number> = {}): string {
  const message = EN[key];
  if (message === undefined) throw new Error(`en.json has no ${key}`);
  return formatMessage("en", message, values);
}

function camel(snake: string): string {
  return snake.replace(/[-_]([a-z])/g, (_m, c: string) => c.toUpperCase());
}

describe("render messages (derived/client.ts DERIVED_SENTENCES)", () => {
  test.each(Object.entries(DERIVED_SENTENCES))("derived.%s", (code, sentence) => {
    expect(en(`derived.${code}`)).toBe(sentence);
  });
});

describe("slice failures (estimates/reasons.ts REASON_WORDS)", () => {
  test.each(Object.entries(REASON_WORDS))("estimate.reason for %s", (reason, words) => {
    expect(en(`estimate.reason.${camel(reason)}`)).toBe(words);
  });
});

describe("upload results (ingest/ingest.ts and uploads/tus.ts)", () => {
  test.each([
    ["upload.result.unsupportedType", UNSUPPORTED_MESSAGE],
    ["upload.result.storageUnavailable", STORAGE_UNAVAILABLE_MESSAGE],
    ["upload.result.modelNotFound", MODEL_NOT_FOUND_MESSAGE],
    ["upload.result.ingestFailed", INGEST_FAILED_MESSAGE],
    ["upload.result.uploadFailed", UPLOAD_FAILED_MESSAGE],
  ])("%s", (key, sentence) => {
    expect(en(key)).toBe(sentence);
  });
});

describe("app API refusals (the web app's CODE_KEYS)", () => {
  test.each([
    ["api.unknownPrinter", UNKNOWN_PRINTER_MESSAGE, {}],
    ["api.printersChanged", PRINTERS_CHANGED, {}],
    ["api.slicerUnavailable", SLICER_UNAVAILABLE_MESSAGE, {}],
    ["api.purgeStarted", PURGE_STARTED_MESSAGE, {}],
    ["api.staleTrash", STALE_TRASH, {}],
    ["api.tokenNameLength", TOKEN_NAME_LENGTH_MESSAGE, { max: MAX_TOKEN_NAME_LENGTH }],
    ["api.titlesNotPreviewed", TITLES_NOT_PREVIEWED_MESSAGE, {}],
    ["api.planChanged", PLAN_CHANGED_MESSAGE, {}],
  ] as const)("%s", (key, sentence, values) => {
    expect(en(key, values)).toBe(sentence);
  });

  test.each([1, 2, 7])("trash.incomplete with %i left", (n) => {
    expect(en("trash.incomplete", { count: n })).toBe(incompleteMessage(n));
  });
});

describe("Activity labels (app-api/activity.ts)", () => {
  test.each(Object.entries(ROW_LABELS))("activity.queue.%s", (id, label) => {
    expect(en(`activity.queue.${id}`)).toBe(label);
  });

  test.each(Object.entries(MAINTENANCE_TASKS))("activity.schedule.%s", (name, key) => {
    expect(en(`activity.schedule.${name}`)).toBe(SCHEDULE_LABELS[key]);
  });

  test("every scheduled job the server labels has a catalog label", () => {
    expect(Object.keys(SCHEDULE_LABELS).sort()).toEqual(Object.values(MAINTENANCE_TASKS).sort());
  });

  test.each([
    ["*/15 * * * *", "activity.when.minutes", { count: 15 }],
    ["0 * * * *", "activity.when.hour", {}],
    ["0 5 * * *", "activity.when.daily", { time: "05:00" }],
  ] as const)("the schedule %s", (cron, key, values) => {
    expect(en(key, { ...values, zone: "UTC" })).toBe(`${scheduleText(cron)} (UTC)`);
  });
});

describe("inbox reasons (inbox/watch.ts)", () => {
  // TOO_LARGE_REASON is left out on purpose: the server's sentence names the
  // limit in bytes and MiB, which the Activity page does not have, so its
  // catalog words (inbox.reason.tooLarge) say the same without the figures.
  test.each([
    ["inbox.reason.changed", CHANGED_REASON],
    ["inbox.reason.unconfirmed", UNCONFIRMED_REASON],
    ["inbox.reason.unremoved", UNREMOVED_REASON],
    ["inbox.reason.unchecked", UNCHECKED_REASON],
    ["inbox.reason.swapped", SWAPPED_REASON],
    ["inbox.reason.putBackFailed", PUT_BACK_FAILED_REASON],
    ["inbox.reason.stillWriting", STILL_WRITING_REASON],
    ["inbox.reason.held", HELD_REASON],
    ["inbox.reason.nonUtf8", NON_UTF8_REASON],
  ])("%s", (key, sentence) => {
    expect(en(key)).toBe(sentence);
  });
});

describe("a duplicate inbox file (ingest/duplicates.ts duplicateMessage, as the reason file says it)", () => {
  const id = "0198f0c4-0000-7000-8000-00000000000a";
  const first = { modelId: id, modelName: "Clip", fileId: "f1", fileName: "Clip.stl" };
  const other = (n: number) => ({ ...first, modelId: `0198f0c4-0000-7000-8000-00000000001${n}` });
  test.each([
    [0, [first]],
    [1, [first, other(1)]],
    [2, [first, other(1), other(2)]],
  ])("inbox.reason.duplicate with %s others", (others, matches) => {
    expect(en("inbox.reason.duplicate", { name: "Clip", id, others })).toBe(
      `${duplicateMessage(matches)}.`,
    );
  });
});

describe("printer names (packages/i18n printers.ts, used by estimates/display.ts)", () => {
  test.each([
    ["Bambu Lab P1S", 0.4],
    ["Bambu Lab H2D", 0.6],
    ["Bambu Lab A1 mini", 0.2],
  ])("printer.full for %s, %s mm", (model, nozzle) => {
    expect(en("printer.full", { model, nozzle: String(nozzle) })).toBe(
      englishPrinterName(model, nozzle),
    );
  });

  test("printer.other", () => {
    expect(en("printer.other")).toBe(OTHER_PRINTER_LABEL);
  });
});
