// The library page (build plan Task 19; AC-020, AC-061, AC-064, AC-073) at /.
//
// - The search is the URL's ?q=, which the top bar's search box (Task 18)
//   sets; ?tag= is the tag filter (Filters). Each change reloads the grid
//   from GET /app/api/library, and Load more follows its nextCursor.
// - The page asks the server for nothing but /app/api: the cards and the tag
//   list. The only images are the /blobs/<id> plate thumbnails the API names
//   (ModelCard), so rendering the library never downloads a model file.
// - The whole page is a drop zone: files dropped on it go to onFiles, which
//   opens the upload dialog. refreshKey reloads the grid (after an upload).
// - Loading, an empty library, no results and a failed load each say so in
//   words, and a failed load can be tried again. A failed Load more keeps
//   the cards already shown and says so beside its button, which then tries
//   the same next page again.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { DropZone } from "../upload/DropZone";
import { Filters } from "./Filters";
import { type LibraryCard, ModelCard } from "./ModelCard";

export interface LibraryPageProps {
  /** Files dropped on the library; the app opens the upload dialog with them. */
  onFiles?: (files: File[]) => void;
  /** Change it to reload the grid, for example once an upload has finished. */
  refreshKey?: number;
}

interface LibraryAnswer {
  printer: string;
  models: LibraryCard[];
  nextCursor: string | null;
}

type Load =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; printer: string; models: LibraryCard[]; nextCursor: string | null };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

export function LibraryPage({ onFiles, refreshKey = 0 }: LibraryPageProps) {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const tag = params.get("tag")?.trim() ?? "";
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tags, setTags] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  /** The last Load more failed; the loaded cards and the cursor are kept. */
  const [moreFailed, setMoreFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  const query = useCallback(
    (cursor?: string) => {
      const search = new URLSearchParams();
      if (q !== "") search.set("q", q);
      if (tag !== "") search.set("tag", tag);
      if (cursor !== undefined) search.set("cursor", cursor);
      const text = search.toString();
      return text === "" ? "/app/api/library" : `/app/api/library?${text}`;
    },
    [q, tag],
  );

  // The grid, again whenever the search, the tag, a refresh or a retry changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and attempt only trigger a reload.
  useEffect(() => {
    const controller = new AbortController();
    const mine = ++generation.current;
    setLoad({ state: "loading" });
    setMoreFailed(false);
    getJson<LibraryAnswer>(query(), controller.signal)
      .then((answer) => {
        if (mine === generation.current) setLoad({ state: "ready", ...answer });
      })
      .catch(() => {
        if (!controller.signal.aborted && mine === generation.current) setLoad({ state: "failed" });
      });
    return () => controller.abort();
  }, [query, refreshKey, attempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only triggers a reload.
  useEffect(() => {
    const controller = new AbortController();
    getJson<{ tags: string[] }>("/app/api/library/tags", controller.signal)
      .then((answer) => setTags(answer.tags))
      .catch(() => {
        // The filter is a convenience: without it the grid still works.
      });
    return () => controller.abort();
  }, [refreshKey]);

  async function loadMore() {
    if (load.state !== "ready" || load.nextCursor === null) return;
    const mine = generation.current;
    setMore(true);
    setMoreFailed(false);
    try {
      const answer = await getJson<LibraryAnswer>(query(load.nextCursor));
      if (mine !== generation.current) return;
      setLoad({
        state: "ready",
        printer: answer.printer,
        models: [...load.models, ...answer.models],
        nextCursor: answer.nextCursor,
      });
    } catch {
      if (mine === generation.current) setMoreFailed(true);
    } finally {
      setMore(false);
    }
  }

  const heading = q === "" ? "Library" : `Results for "${q}"`;

  return (
    <DropZone onFiles={(files) => onFiles?.(files)}>
      <div className="studio-page-head">
        <h1>{heading}</h1>
        {load.state === "ready" && load.printer !== "" ? (
          <p className="studio-muted">Times and weights for {load.printer}</p>
        ) : null}
      </div>
      <Filters tags={tags} />
      <div aria-live="polite">
        {load.state === "loading" ? <p className="studio-muted">Loading the library</p> : null}
        {load.state === "failed" ? (
          <div className="studio-alert studio-alert-alert" role="alert">
            <p>The library could not be loaded.</p>
            <button
              type="button"
              className="studio-button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : null}
        {load.state === "ready" && load.models.length === 0 ? (
          <p className="studio-empty">
            {q === "" && tag === ""
              ? "No models yet. Drop files here, or use Add."
              : "No models match. Try another search or tag."}
          </p>
        ) : null}
      </div>
      {load.state === "ready" && load.models.length > 0 ? (
        <>
          <ul className="studio-grid" aria-label="Models">
            {load.models.map((card) => (
              <ModelCard key={card.id} card={card} />
            ))}
          </ul>
          {load.nextCursor === null ? null : (
            <div className="studio-pager">
              {moreFailed ? (
                <p className="studio-muted" role="alert">
                  More models could not be loaded.
                </p>
              ) : null}
              <button type="button" className="studio-button" disabled={more} onClick={loadMore}>
                {more ? "Loading" : moreFailed ? "Try again" : "Load more"}
              </button>
            </div>
          )}
        </>
      ) : null}
    </DropZone>
  );
}
