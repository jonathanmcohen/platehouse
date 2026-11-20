// The About tab (build plan Task 20; AC-022 display): the caption, the
// creator, the MakerWorld page when the model's .3mf named one (View on
// MakerWorld, also beside the creator in the page head), the licence with the stored licence note beside it (so a
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
import { useI18n } from "../i18n/I18n";
import type { ModelView } from "./ModelPage";

type Rendered = { markdown: string; html: string | null };

/**
 * The only address "View on MakerWorld" ever opens: a MakerWorld model page,
 * https://makerworld.com/models/<digits>, as the server builds it from the
 * design ID the .3mf carried (packages/threemf makerWorldUrl). The server
 * never passes a URL from a file through; this check makes sure the page
 * cannot either.
 */
const MAKERWORLD_MODEL = /^https:\/\/makerworld\.com\/models\/[1-9][0-9]{0,14}$/;

/** The address to link, or null when it is not a MakerWorld model page. */
export function makerWorldHref(url: string | null | undefined): string | null {
  return typeof url === "string" && MAKERWORLD_MODEL.test(url) ? url : null;
}

/**
 * "View on MakerWorld", opened in a new tab with rel="noopener noreferrer";
 * nothing when the model has no MakerWorld page.
 */
export function MakerWorldLink({ url }: { url: string | null | undefined }) {
  const { t } = useI18n();
  const href = makerWorldHref(url);
  if (href === null) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {t("model.about.makerWorld")}
    </a>
  );
}

function Description({ markdown }: { markdown: string }) {
  const { t } = useI18n();
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
    return <p className="studio-muted">{t("model.about.loadingDescription")}</p>;
  }
  const { html } = rendered;
  if (html === null) return <p className="studio-muted">{t("model.about.descriptionFailed")}</p>;
  return (
    <div
      className="studio-prose"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown's output (Task 7) is already sanitised with DOMPurify, and nothing is added to it.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function AboutTab({ model }: { model: ModelView }) {
  const { t, fmt } = useI18n();
  const licence = [model.license, model.licenseNote].filter(
    (v): v is string => v !== null && v.trim() !== "",
  );
  return (
    <>
      {model.caption === null ? null : <p className="studio-caption">{model.caption}</p>}
      <dl className="studio-dl">
        <dt>{t("model.about.creator")}</dt>
        <dd>{model.creator ?? t("model.about.notKnown")}</dd>
        {makerWorldHref(model.makerWorldUrl) === null ? null : (
          <>
            <dt>{t("model.about.source")}</dt>
            <dd>
              <MakerWorldLink url={model.makerWorldUrl} />
            </dd>
          </>
        )}
        <dt>{t("model.about.licence")}</dt>
        <dd>{licence.length === 0 ? t("model.about.notSet") : licence.join(" - ")}</dd>
        <dt>{t("model.about.tags")}</dt>
        <dd>{model.tags.length === 0 ? t("model.about.none") : fmt.list(model.tags)}</dd>
        <dt>{t("model.about.collections")}</dt>
        <dd>
          {model.collections.length === 0 ? t("model.about.none") : fmt.list(model.collections)}
        </dd>
      </dl>
      {model.description === null || model.description.trim() === "" ? (
        <p className="studio-muted">{t("model.about.noDescription")}</p>
      ) : (
        <Description markdown={model.description} />
      )}
    </>
  );
}
