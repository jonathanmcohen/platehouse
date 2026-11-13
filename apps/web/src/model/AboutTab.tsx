// The About tab (build plan Task 20; AC-022 display): the caption, the
// creator, the licence with the stored licence note beside it (so a
// MakerWorld-only licence such as the Standard Digital File License shows
// even when the description was already set and ingest left it alone; Jon,
// 2026-11-08, PR #49), the tags and collections, and the description.
//
// The description is Markdown, rendered by Task 7's renderMarkdown, which
// sanitises it with DOMPurify in this browser: raw HTML, scripts, images
// and non-http(s) links never come through. Its output is the only HTML
// this page sets; nothing else is added to it. The renderer (markdown-it
// and DOMPurify) is imported on first use, so it stays out of the bundle
// every page loads.
import { useEffect, useState } from "react";
import type { ModelView } from "./ModelPage";

type Rendered = { markdown: string; html: string | null };

function Description({ markdown }: { markdown: string }) {
  const [rendered, setRendered] = useState<Rendered | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("@platehouse/makerworld")
      .then(({ renderMarkdown }) => renderMarkdown(markdown))
      // No DOM to sanitise with, or the renderer failed to load: show
      // nothing rather than unsanitised HTML.
      .catch(() => null)
      .then((html) => {
        if (!cancelled) setRendered({ markdown, html });
      });
    return () => {
      cancelled = true;
    };
  }, [markdown]);

  if (rendered === null || rendered.markdown !== markdown) {
    return <p className="studio-muted">Loading the description...</p>;
  }
  const { html } = rendered;
  if (html === null) return <p className="studio-muted">The description could not be shown.</p>;
  return (
    <div
      className="studio-prose"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown's output (Task 7) is already sanitised with DOMPurify, and nothing is added to it.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function AboutTab({ model }: { model: ModelView }) {
  const licence = [model.license, model.licenseNote].filter(
    (v): v is string => v !== null && v.trim() !== "",
  );
  return (
    <>
      {model.caption === null ? null : <p className="studio-caption">{model.caption}</p>}
      <dl className="studio-dl">
        <dt>Creator</dt>
        <dd>{model.creator ?? "Not known"}</dd>
        <dt>Licence</dt>
        <dd>{licence.length === 0 ? "Not set" : licence.join(" - ")}</dd>
        <dt>Tags</dt>
        <dd>{model.tags.length === 0 ? "None" : model.tags.join(", ")}</dd>
        <dt>Collections</dt>
        <dd>{model.collections.length === 0 ? "None" : model.collections.join(", ")}</dd>
      </dl>
      {model.description === null || model.description.trim() === "" ? (
        <p className="studio-muted">No description.</p>
      ) : (
        <Description markdown={model.description} />
      )}
    </>
  );
}
