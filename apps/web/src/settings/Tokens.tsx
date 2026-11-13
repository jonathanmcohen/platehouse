// API tokens on the settings page (build plan Task 21; AC-083 UI). Jon
// makes one token per API client (Claude Code on each Mac) and revokes it
// here. A new token is shown once, in a themed dialog with Copy, and never
// again: it is held only while that dialog is open, never put in the list,
// and the server never answers it a second time. The list shows each live
// token's name, its first 8 characters and when it was last used. Revoking
// asks first, in a themed dialog, since it cannot be undone.
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { appApi, errorText, formatDate, segment, useAppApi } from "./api";
import { ConfirmDialog, Dialog } from "./Dialog";

/** A live token as the list shows it. */
export interface ListedToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The create answer: the listed fields and, this once, the token itself. */
interface CreatedAnswer extends ListedToken {
  token: string;
}

/** The longest token name the server takes. */
const MAX_NAME = 100;

function NewToken({
  name,
  value,
  onDone,
  returnFocusTo,
}: {
  name: string;
  value: string;
  onDone(): void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <Dialog title="New API token" onClose={onDone} returnFocusTo={returnFocusTo}>
      <p>
        This is the only time the token for {name} is shown. Copy it now and keep it somewhere safe,
        such as 1Password.
      </p>
      <code className="ph-token-value">{value}</code>
      <p role="status">
        {copy === "copied" ? "Copied." : null}
        {copy === "failed" ? "Copy did not work here. Select the token and copy it by hand." : null}
      </p>
      <div className="studio-actions">
        <button type="button" className="studio-button studio-button-primary" onClick={copyValue}>
          {copy === "copied" ? "Copied" : "Copy"}
        </button>
        <button type="button" className="studio-button" onClick={onDone}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

export function Tokens() {
  const nameId = useId();
  const list = useAppApi<{ tokens: ListedToken[] }>("/tokens");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** The new token, held only while its dialog is open. */
  const [created, setCreated] = useState<{ name: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<ListedToken | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());
  const revokeReturn = useRef<HTMLElement | null>(null);
  const rows = list.data?.tokens ?? [];

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") {
      setError("Give the token a name, such as the machine it is for.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const answer = await appApi<CreatedAnswer>("POST", "/tokens", { name: trimmed });
      // Only the listed fields go into the list; the token stays in the dialog.
      const row: ListedToken = {
        id: answer.id,
        name: answer.name,
        prefix: answer.prefix,
        createdAt: answer.createdAt,
        lastUsedAt: answer.lastUsedAt,
      };
      list.set((prev) => ({ tokens: [row, ...prev.tokens.filter((r) => r.id !== row.id)] }));
      setName("");
      setCreated({ name: answer.name, value: answer.token });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: ListedToken) {
    await appApi("DELETE", `/tokens/${segment(item.id)}`);
    list.set((prev) => ({ tokens: prev.tokens.filter((r) => r.id !== item.id) }));
    // Its own button is gone with it; focus goes to Create token.
    revokeReturn.current = createButton.current;
    setRevoking(null);
  }

  return (
    <div className="ph-section">
      <h2>API tokens</h2>
      <p className="studio-muted">
        Each API client, such as Claude Code on one Mac, gets its own token. A token is shown once,
        when it is made.
      </p>
      <form className="ph-inline-form" onSubmit={create}>
        <label htmlFor={nameId}>Token name</label>
        <input
          id={nameId}
          className="studio-input"
          value={name}
          maxLength={MAX_NAME}
          autoComplete="off"
          placeholder="Claude Code on mini01"
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <button ref={createButton} type="submit" className="studio-button" disabled={busy}>
          Create token
        </button>
      </form>
      {error === undefined ? null : <p className="studio-alert studio-alert-alert">{error}</p>}
      {list.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{list.error}</p>
      )}
      {list.data === undefined && list.error === undefined ? (
        <p className="studio-muted">Loading the tokens.</p>
      ) : null}
      {list.data !== undefined && rows.length === 0 ? (
        <p className="studio-empty">No API tokens yet.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="studio-list">
          {rows.map((item) => (
            <li key={item.id} className="studio-list-item">
              <div className="studio-row">
                <strong>{item.name}</strong>
                <button
                  ref={(el) => {
                    if (el === null) revokeButtons.current.delete(item.id);
                    else revokeButtons.current.set(item.id, el);
                  }}
                  type="button"
                  className="studio-button ph-small ph-button-danger"
                  aria-label={`Revoke ${item.name}`}
                  onClick={() => {
                    revokeReturn.current = revokeButtons.current.get(item.id) ?? null;
                    setRevoking(item);
                  }}
                >
                  Revoke
                </button>
              </div>
              <span className="studio-muted">
                <code>{item.prefix}</code>
                {"... made "}
                <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                {", "}
                {item.lastUsedAt === null ? (
                  "never used"
                ) : (
                  <>
                    {"last used "}
                    <time dateTime={item.lastUsedAt}>{formatDate(item.lastUsedAt, true)}</time>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {created === null ? null : (
        <NewToken
          name={created.name}
          value={created.value}
          onDone={() => setCreated(null)}
          returnFocusTo={createButton}
        />
      )}
      {revoking === null ? null : (
        <ConfirmDialog
          title="Revoke this token?"
          message={`${revoking.name} stops working at once. Anything that uses it is refused until it has a new token.`}
          confirmLabel="Revoke"
          onConfirm={() => revoke(revoking)}
          onCancel={() => setRevoking(null)}
          returnFocusTo={revokeReturn}
        />
      )}
    </div>
  );
}
