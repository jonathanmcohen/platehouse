// The API reference (AC-084, AC-085): the Public API v1 for a person who
// wants to script Platehouse, on the settings page at /settings?view=api,
// linked from the API tokens section. It renders the OpenAPI document this
// build serves (./openapi.json, see model.ts), grouped by tag: each
// operation's method, path, summary and description, its parameters, its
// request body and every answer, with their fields and examples.
//
// - Built from the app's own pieces (studio.css and organise.css tokens and
//   shapes, api-docs.css for the rest); nothing is fetched, from a CDN or
//   anywhere: the document is bundled, so the page needs no token and works
//   under the app's CSP. The settings page loads this module only when the
//   page is opened, so the document is not in the main bundle.
// - Every operation is a details element: a keyboard opens it with Enter or
//   Space, a screen reader announces it as expandable, and its summary holds
//   a heading, so the page's headings list every operation. Sections use
//   h2, operations h3, their parts h4 and each answer h5.
// - The base URL is this page's own origin with /api/v1: the API is served
//   from the same configured public origin as the web app (AC-091).
// - Nothing scrolls sideways at 375 px: paths, field names and examples
//   wrap, and example blocks scroll inside themselves.
// - Opened by a link (focusHeading), the page puts focus on its heading, as
//   SettingsPage explains.
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import "./api-docs.css";
import {
  type ApiDocument,
  examplesOf,
  type Field,
  fieldsOf,
  groupOperations,
  type Media,
  type Operation,
  type Parameter,
  paragraphs,
  placeLabel,
  rulesOf,
  type Schema,
  typeLabel,
} from "./model";
import raw from "./openapi.json";

const DOC = raw as unknown as ApiDocument;

/** The deepest indent api-docs.css draws; deeper fields share it. No inline style (CSP). */
const MAX_DEPTH = 5;

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {paragraphs(text).map((p) => (
        <p key={p}>{p}</p>
      ))}
    </>
  );
}

function Examples({ media, label }: { media: Media; label: string }) {
  const examples = examplesOf(media);
  if (examples.length === 0) return null;
  return (
    <div className="ph-api-examples">
      {examples.map((ex, i) => (
        <figure key={ex.label === "" ? i : ex.label} className="ph-api-example">
          <figcaption className="studio-muted">
            {ex.label === "" ? `Example ${label}` : `Example ${label}: ${ex.label}`}
          </figcaption>
          {/* A scrollable region a keyboard can reach, named by its caption. */}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: an example wider than a phone scrolls, and a keyboard user must be able to scroll it (WCAG 2.1.1). */}
          <pre tabIndex={0}>
            <code>{ex.text}</code>
          </pre>
        </figure>
      ))}
    </div>
  );
}

function FieldMeta({ field }: { field: Pick<Field, "type" | "required" | "nullable" | "rules"> }) {
  const parts = [field.type];
  if (field.required) parts.push("required");
  if (field.nullable) parts.push("may be null");
  parts.push(...field.rules);
  return <span className="studio-muted ph-api-meta">{parts.join(", ")}</span>;
}

function Fields({ schema }: { schema: Schema | undefined }) {
  const fields = fieldsOf(schema);
  if (schema === undefined) return null;
  if (fields.length === 0) {
    return (
      <p className="studio-muted">
        {typeLabel(schema)}
        {schema.description === undefined ? null : `: ${schema.description}`}
      </p>
    );
  }
  return (
    <ul className="ph-api-fields">
      {fields.map((field, i) => (
        <li
          // Field names repeat at different depths; the position is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for a build.
          key={`${field.depth}-${field.name}-${i}`}
          className={`ph-api-field ph-api-depth-${Math.min(field.depth, MAX_DEPTH)}`}
        >
          <code>{field.name}</code> <FieldMeta field={field} />
          {field.description === "" ? null : <span>{field.description}</span>}
        </li>
      ))}
    </ul>
  );
}

function Parameters({ parameters }: { parameters: Parameter[] }) {
  if (parameters.length === 0) return null;
  return (
    <>
      <h4>Parameters</h4>
      <ul className="ph-api-fields">
        {parameters.map((p) => {
          const schema = p.schema ?? {};
          return (
            <li key={`${p.in}-${p.name}`} className="ph-api-field">
              <code>{p.name}</code>{" "}
              <FieldMeta
                field={{
                  type: `${placeLabel(p.in)}, ${typeLabel(schema)}`,
                  required: p.required === true,
                  nullable: false,
                  rules: rulesOf(schema),
                }}
              />
              {p.description === undefined ? null : <span>{p.description}</span>}
              {p.example === undefined ? null : (
                <span className="studio-muted">
                  Example: <code>{String(p.example)}</code>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function OperationCard({ op }: { op: Operation }) {
  return (
    <details className="ph-api-op" id={op.id}>
      <summary>
        <h3>
          <span className="ph-api-method">{op.method}</span> <code>{op.path}</code>{" "}
          <span className="ph-api-summary">{op.summary}</span>
        </h3>
      </summary>
      <div className="ph-api-body">
        <Paragraphs text={op.description} />
        {op.alsoHead ? (
          <p className="studio-muted">
            HEAD <code>{op.path}</code> answers the same status and headers, with no body.
          </p>
        ) : null}
        <Parameters parameters={op.parameters} />
        {op.requestBody.length === 0 ? null : (
          <>
            <h4>Request body</h4>
            {op.requestBody.map((body) => (
              <div key={body.type} className="ph-api-part">
                <p className="studio-muted">
                  <code>{body.type}</code>
                </p>
                {body.description === "" ? null : <p>{body.description}</p>}
                <Fields schema={body.media.schema} />
                <Examples media={body.media} label="body" />
              </div>
            ))}
          </>
        )}
        <h4>Responses</h4>
        {op.responses.map(({ code, response }) => (
          <div key={code} className="ph-api-part">
            <h5>
              <span className="ph-api-code">{code}</span> {response.description}
            </h5>
            {Object.keys(response.headers ?? {}).length === 0 ? null : (
              <ul className="ph-api-fields">
                {Object.entries(response.headers ?? {}).map(([name, header]) => (
                  <li key={name} className="ph-api-field">
                    <code>{name}</code> <span className="studio-muted ph-api-meta">header</span>
                    {header.description === undefined ? null : <span>{header.description}</span>}
                  </li>
                ))}
              </ul>
            )}
            {Object.entries(response.content ?? {}).map(([type, media]) => (
              <div key={type} className="ph-api-part">
                <p className="studio-muted">
                  <code>{type}</code>
                </p>
                <Fields schema={media.schema} />
                <Examples media={media} label={code} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

export interface ApiReferenceProps {
  /** The OpenAPI document; this build's own when left out. */
  doc?: ApiDocument;
  /** Puts focus on the heading when the page appears (a link opened it). */
  focusHeading?: boolean;
}

export function ApiReference({ doc = DOC, focusHeading = false }: ApiReferenceProps) {
  const groups = groupOperations(doc);
  const base = `${window.location.origin}/api/v1`;
  const heading = useRef<HTMLHeadingElement>(null);

  // Once, when the page appears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount.
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, []);

  return (
    <div className="ph-api">
      <div className="studio-page-head">
        <h1 ref={heading} tabIndex={-1}>
          API reference
        </h1>
        <Link to="/settings">Back to Settings</Link>
      </div>
      <div className="studio-prose ph-api-intro">
        <Paragraphs text={doc.info.description ?? ""} />
        <dl className="studio-dl">
          <dt>Base URL</dt>
          <dd>
            <code>{base}</code>
          </dd>
          <dt>Token</dt>
          <dd>
            Make one in <Link to="/settings">Settings</Link>, under API tokens, and send it on every
            request as <code>Authorization: Bearer &lt;token&gt;</code>.
          </dd>
          <dt>OpenAPI</dt>
          <dd>
            <code>GET {base}/openapi.json</code>, with a token. API version {doc.info.version}.
          </dd>
        </dl>
      </div>
      <nav aria-label="API sections">
        <ul className="studio-chips">
          {groups.map((group) => (
            <li key={group.id}>
              <a className="studio-chip" href={`#${group.id}`}>
                {group.name}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {groups.map((group) => (
        <section key={group.id} className="ph-section" aria-labelledby={group.id}>
          <h2 id={group.id}>{group.name}</h2>
          {group.description === "" ? null : <p className="studio-muted">{group.description}</p>}
          <div className="ph-api-ops">
            {group.operations.map((op) => (
              <OperationCard key={op.id} op={op} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default ApiReference;
