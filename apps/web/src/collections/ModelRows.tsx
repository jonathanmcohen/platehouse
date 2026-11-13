// The models of one creator, collection or tag, each ready to organise
// (build plan Task 21; AC-060 to AC-063): inline rename of the model and of
// each of its files, tag chips and collection chips that can be added and
// removed, and Move to trash. Every change goes to the app API and, once it
// answers, shows on the row; a refusal shows its sentence on the row.
import { useState } from "react";
import { appApi, errorText, segment } from "../settings/api";
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

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function ModelRow({
  model,
  onChange,
  onTrashed,
}: {
  model: OrganiseModel;
  onChange(next: OrganiseModel): void;
  onTrashed(): void;
}) {
  const [error, setError] = useState<string | undefined>(undefined);
  const id = segment(model.id);

  async function trash() {
    setError(undefined);
    try {
      await appApi("POST", `/models/${id}/trash`);
      onTrashed();
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  return (
    <li className="studio-list-item">
      <div className="studio-row">
        <div className="ph-model-name">
          <InlineRename
            value={model.name}
            buttonLabel={`Rename ${model.name}`}
            inputLabel={`New name for ${model.name}`}
            onSave={async (name) => {
              await appApi("PATCH", `/models/${id}`, { name });
              onChange({ ...model, name });
            }}
          />
        </div>
        <button
          type="button"
          className="studio-button ph-small ph-button-danger"
          aria-label={`Move ${model.name} to the trash`}
          onClick={trash}
        >
          Move to trash
        </button>
      </div>
      {model.creator === null ? null : <span className="studio-muted">By {model.creator}</span>}
      {error === undefined ? null : <p className="studio-alert studio-alert-alert">{error}</p>}
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
                  onChange({
                    ...model,
                    files: model.files.map((f) => (f.id === file.id ? { ...f, name } : f)),
                  });
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
          await appApi("PUT", `/models/${id}/tags/${segment(tag)}`);
          if (!model.tags.some((t) => sameName(t, tag))) {
            onChange({ ...model, tags: [...model.tags, tag] });
          }
        }}
        onRemove={async (tag) => {
          await appApi("DELETE", `/models/${id}/tags/${segment(tag)}`);
          onChange({ ...model, tags: model.tags.filter((t) => t !== tag) });
        }}
      />
      <span className="studio-filaments-label">Collections</span>
      <ChipEditor
        values={model.collections}
        addLabel={`Add ${model.name} to a collection`}
        addButton="Add"
        removeLabel={(name) => `Remove ${model.name} from collection ${name}`}
        onAdd={async (name) => {
          await appApi("PUT", `/collections/${segment(name)}/models/${id}`);
          if (!model.collections.some((c) => sameName(c, name))) {
            onChange({ ...model, collections: [...model.collections, name] });
          }
        }}
        onRemove={async (name) => {
          await appApi("DELETE", `/collections/${segment(name)}/models/${id}`);
          onChange({ ...model, collections: model.collections.filter((c) => c !== name) });
        }}
      />
    </li>
  );
}

export interface ModelRowsProps {
  models: OrganiseModel[];
  onChange(models: OrganiseModel[]): void;
}

export function ModelRows({ models, onChange }: ModelRowsProps) {
  const [status, setStatus] = useState("");

  return (
    <>
      <p role="status">{status}</p>
      <ul className="studio-list">
        {models.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            onChange={(next) => onChange(models.map((m) => (m.id === next.id ? next : m)))}
            onTrashed={() => {
              onChange(models.filter((m) => m.id !== model.id));
              setStatus(
                `Moved ${model.name} to the trash. Restore it from the trash within 30 days.`,
              );
            }}
          />
        ))}
      </ul>
    </>
  );
}
