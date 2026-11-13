// The shape the Creators, Collections and Tags pages share (build plan Task
// 21). Without ?name= the page lists every creator, collection or tag that
// has live models, with how many. With ?name= it shows that one's models,
// each ready to organise (ModelRows), and a link to the library filtered by
// it. The name lives in the query string, so the page path stays the one
// shell page the server answers (SHELL_PAGES) and a reload or a shared link
// shows the same thing.
import { Link, useSearchParams } from "react-router";
import { useAppApi } from "../settings/api";
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

function GroupList({ title, listPath, emptyText }: GroupPageProps) {
  const key = listPath.slice(1) as "creators" | "collections" | "tags";
  const list = useAppApi<Record<string, Group[]>>(listPath);
  const groups = list.data?.[key] ?? [];
  return (
    <>
      <div className="studio-page-head">
        <h1>{title}</h1>
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
                <Link to={`?${new URLSearchParams({ name: group.name })}`}>{group.name}</Link>
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

function GroupModels({ title, filter, name }: GroupPageProps & { name: string }) {
  const rows = useAppApi<{ models: OrganiseModel[]; nextCursor: string | null }>(
    `/organise/models?${new URLSearchParams({ [filter]: name })}`,
  );
  const models = rows.data?.models ?? [];
  return (
    <>
      <div className="studio-page-head">
        <h1>{title}</h1>
        <Link to=".">All {title.toLowerCase()}</Link>
      </div>
      <div className="ph-section">
        <div className="studio-row">
          <h2>{name}</h2>
          <Link to={`/?${new URLSearchParams({ [filter]: name })}`}>Show in the library</Link>
        </div>
        {rows.error === undefined ? null : (
          <p className="studio-alert studio-alert-alert">{rows.error}</p>
        )}
        {rows.data === undefined && rows.error === undefined ? (
          <p className="studio-muted">Loading the models.</p>
        ) : null}
        {rows.data !== undefined && models.length === 0 ? (
          <p className="studio-empty">No models here.</p>
        ) : null}
        {models.length > 0 ? (
          <ModelRows
            models={models}
            update={(change) => rows.set((prev) => ({ ...prev, models: change(prev.models) }))}
          />
        ) : null}
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
  if (name === "") return <GroupList {...props} />;
  return <GroupModels {...props} name={name} />;
}
