// The shape the Creators, Collections and Tags pages share (build plan Task
// 21). Without ?name= the page lists every creator, collection or tag that
// has live models, with how many. With ?name= it shows that one's models,
// each ready to organise (ModelRows), and a link to the library filtered by
// it. ModelRows stays on the page once the models are in, even when the
// last one is moved to the trash, so its status line can say so and take
// focus. The name lives in the query string, so the page path stays the one
// shell page the server answers (SHELL_PAGES) and a reload or a shared link
// shows the same thing.
//
// Following a name in the list, or the All link back, swaps one view for the
// other in place, and the link that was pressed leaves with the old view.
// So, as the shell does after a menu link, focus then goes to the new view's
// heading (the name's heading, or the page heading for the list), each
// focusable with tabIndex -1, rather than falling to the page body.
import { type Ref, useLayoutEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { useAppApi } from "../settings/api";
import { focusFirst, focusLost } from "../settings/focus";
import { ModelRows, type OrganiseModel } from "./ModelRows";
import "../settings/organise.css";

export interface GroupPageProps {
  /** The page's heading, such as "Collections". */
  title: string;
  /** The app API list, such as "/collections". */
  listPath: "/creators" | "/collections" | "/tags";
  /** The key of the list in the answer, and the library filter: creator, collection or tag. */
  filter: "creator" | "collection" | "tag";
  /** What the list says when there is nothing in it. */
  emptyText: string;
}

interface Group {
  name: string;
  models: number;
}

interface ViewProps {
  /** The view's heading, which takes focus after a swap. */
  heading: Ref<HTMLHeadingElement>;
  /** Called when a link that swaps the view is followed. */
  onSwap: () => void;
}

function GroupList({ title, listPath, emptyText, heading, onSwap }: GroupPageProps & ViewProps) {
  const key = listPath.slice(1) as "creators" | "collections" | "tags";
  const list = useAppApi<Record<string, Group[]>>(listPath);
  const groups = list.data?.[key] ?? [];
  return (
    <>
      <div className="studio-page-head">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
      </div>
      {list.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{list.error}</p>
      )}
      {list.data === undefined && list.error === undefined ? (
        <p className="studio-muted">Loading.</p>
      ) : null}
      {list.data !== undefined && groups.length === 0 ? (
        <p className="studio-empty">{emptyText}</p>
      ) : null}
      {groups.length > 0 ? (
        <ul className="studio-list">
          {groups.map((group) => (
            <li key={group.name} className="studio-list-item">
              <div className="studio-row">
                <Link to={`?${new URLSearchParams({ name: group.name })}`} onClick={onSwap}>
                  {group.name}
                </Link>
                <span className="studio-muted">
                  {group.models} {group.models === 1 ? "model" : "models"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function GroupModels({
  title,
  filter,
  name,
  heading,
  onSwap,
}: GroupPageProps & ViewProps & { name: string }) {
  const rows = useAppApi<{ models: OrganiseModel[]; nextCursor: string | null }>(
    `/organise/models?${new URLSearchParams({ [filter]: name })}`,
  );
  const models = rows.data?.models ?? [];
  return (
    <>
      <div className="studio-page-head">
        <h1>{title}</h1>
        <Link to="." onClick={onSwap}>
          All {title.toLowerCase()}
        </Link>
      </div>
      <div className="ph-section">
        <div className="studio-row">
          <h2 ref={heading} tabIndex={-1}>
            {name}
          </h2>
          <Link to={`/?${new URLSearchParams({ [filter]: name })}`}>Show in the library</Link>
        </div>
        {rows.error === undefined ? null : (
          <p className="studio-alert studio-alert-alert">{rows.error}</p>
        )}
        {rows.data === undefined && rows.error === undefined ? (
          <p className="studio-muted">Loading the models.</p>
        ) : null}
        {rows.data === undefined ? null : (
          <ModelRows
            models={models}
            update={(change) => rows.set((prev) => ({ ...prev, models: change(prev.models) }))}
          />
        )}
        {rows.data?.nextCursor ? (
          <p className="studio-muted">
            Only the first {models.length} models are shown here; the library shows them all.
          </p>
        ) : null}
      </div>
    </>
  );
}

export function GroupPage(props: GroupPageProps) {
  const [params] = useSearchParams();
  const name = params.get("name")?.trim() ?? "";
  const heading = useRef<HTMLHeadingElement>(null);
  const swapping = useRef(false);
  const shown = useRef(name);

  // Once the view a link asked for is on the page, its heading takes focus,
  // unless the user has already put focus somewhere else on the page.
  useLayoutEffect(() => {
    if (shown.current === name) return;
    shown.current = name;
    if (!swapping.current) return;
    swapping.current = false;
    if (focusLost()) focusFirst([heading.current]);
  });

  const view = {
    heading,
    onSwap: () => {
      swapping.current = true;
    },
  };
  if (name === "") return <GroupList {...props} {...view} />;
  return <GroupModels {...props} {...view} name={name} />;
}
