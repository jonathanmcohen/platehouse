// The models of one creator, collection or tag, each ready to organise
// (build plan Task 21; AC-060 to AC-063): inline rename of the model and of
// each of its files, tag chips and collection chips that can be added and
// removed, and Move to trash. Every change goes to the app API and, once it
// answers, shows on the row; a refusal shows its sentence on the row. Each
// change is applied to the list as it is when that change answers (an
// updater, never a copy taken at the click), so two changes in flight, on
// one row or two, never undo each other. Tags and collections are one per
// name ignoring case, so an added chip shows the name the server answers
// with, the one stored, which may differ in capitals from the one typed.
// A tag or collection name goes in the query string, never the path (see
// nameQuery in ../settings/api). While Move to trash runs it is marked
// aria-disabled and ignores a press. When a row leaves the page, focus goes
// to the next row's Move to trash, else the previous row's, else the status
// line saying what happened (useRowFocus in ../settings/focus).
import { useRef, useState } from "react";
import { appApi, errorText, nameQuery, segment } from "../settings/api";
import { type RowFocus, useRowFocus } from "../settings/focus";
import { ChipEditor } from "./ChipEditor";
import { InlineRename } from "./InlineRename";

/** A model as GET /app/api/organise/models answers it. */
export interface OrganiseModel {
  id: string;
  name: string;
  creator: string | null;
  tags: string[];
  collections: string[];
  files: Array<{ id: string; name: string; kind: string }>;
}

/** What PUT answers for a tag or a collection: the name it is stored under. */
interface StoredName {
  name: string;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Changes a list of models, or one model, as it is when the change lands. */
export type Update<T> = (change: (prev: T) => T) => void;

function ModelRow({
  model,
  update,
  onTrashed,
  focus,
}: {
  model: OrganiseModel;
  update: Update<OrganiseModel>;
  onTrashed(): void;
  focus: RowFocus;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [trashing, setTrashing] = useState(false);
  const id = segment(model.id);

  async function trash() {
    if (trashing) return;
    setTrashing(true);
    setError(undefined);
    try {
      await appApi("POST", `/models/${id}/trash`);
      onTrashed();
    } catch (failure) {
      setError(errorText(failure));
      setTrashing(false);
    }
  }

  return (
    <li className="studio-list-item" onFocus={focus.focusIn(model.id)}>
      <div className="studio-row">
        <div className="ph-model-name">
          <InlineRename
            value={model.name}
            buttonLabel={`Rename ${model.name}`}
            inputLabel={`New name for ${model.name}`}
            onSave={async (name) => {
              await appApi("PATCH", `/models/${id}`, { name });
              update((m) => ({ ...m, name }));
            }}
          />
        </div>
        <button
          ref={focus.control(model.id)}
          type="button"
          className="studio-button ph-small ph-button-danger"
          aria-label={`Move ${model.name} to the trash`}
          aria-disabled={trashing}
          onClick={trash}
        >
          Move to trash
        </button>
      </div>
      {model.creator === null ? null : <span className="studio-muted">By {model.creator}</span>}
      {error === undefined ? null : (
        <p role="alert" className="studio-alert studio-alert-alert">
          {error}
        </p>
      )}
      {model.files.length === 0 ? null : (
        <ul className="studio-list" aria-label={`Files of ${model.name}`}>
          {model.files.map((file) => (
            <li key={file.id}>
              <InlineRename
                value={file.name}
                buttonLabel={`Rename ${file.name}`}
                inputLabel={`New name for ${file.name}`}
                onSave={async (name) => {
                  await appApi("PATCH", `/files/${segment(file.id)}`, { name });
                  update((m) => ({
                    ...m,
                    files: m.files.map((f) => (f.id === file.id ? { ...f, name } : f)),
                  }));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <span className="studio-filaments-label">Tags</span>
      <ChipEditor
        values={model.tags}
        addLabel={`Add a tag to ${model.name}`}
        addButton="Add tag"
        removeLabel={(tag) => `Remove tag ${tag} from ${model.name}`}
        onAdd={async (tag) => {
          const { name } = await appApi<StoredName>("PUT", `/models/${id}/tags${nameQuery(tag)}`);
          update((m) =>
            m.tags.some((t) => sameName(t, name)) ? m : { ...m, tags: [...m.tags, name] },
          );
        }}
        onRemove={async (tag) => {
          await appApi("DELETE", `/models/${id}/tags${nameQuery(tag)}`);
          update((m) => ({ ...m, tags: m.tags.filter((t) => t !== tag) }));
        }}
      />
      <span className="studio-filaments-label">Collections</span>
      <ChipEditor
        values={model.collections}
        addLabel={`Add ${model.name} to a collection`}
        addButton="Add"
        removeLabel={(name) => `Remove ${model.name} from collection ${name}`}
        onAdd={async (typed) => {
          const { name } = await appApi<StoredName>(
            "PUT",
            `/models/${id}/collections${nameQuery(typed)}`,
          );
          update((m) =>
            m.collections.some((c) => sameName(c, name))
              ? m
              : { ...m, collections: [...m.collections, name] },
          );
        }}
        onRemove={async (name) => {
          await appApi("DELETE", `/models/${id}/collections${nameQuery(name)}`);
          update((m) => ({ ...m, collections: m.collections.filter((c) => c !== name) }));
        }}
      />
    </li>
  );
}

export interface ModelRowsProps {
  models: OrganiseModel[];
  /** Changes the shown list as it is when a change answers. */
  update: Update<OrganiseModel[]>;
}

export function ModelRows({ models, update }: ModelRowsProps) {
  const [status, setStatus] = useState("");
  const statusLine = useRef<HTMLParagraphElement>(null);
  const focus = useRowFocus(
    models.map((m) => m.id),
    statusLine,
  );

  return (
    <>
      <p ref={statusLine} role="status" tabIndex={-1}>
        {status}
      </p>
      {models.length === 0 ? <p className="studio-empty">No models here.</p> : null}
      {models.length === 0 ? null : (
        <ul className="studio-list">
          {models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              focus={focus}
              update={(change) =>
                update((list) => list.map((m) => (m.id === model.id ? change(m) : m)))
              }
              onTrashed={() => {
                update((list) => list.filter((m) => m.id !== model.id));
                setStatus(
                  `Moved ${model.name} to the trash. Restore it from the trash within 30 days.`,
                );
              }}
            />
          ))}
        </ul>
      )}
    </>
  );
}
