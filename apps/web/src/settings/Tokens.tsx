// API tokens on the settings page (build plan Task 21; AC-083 UI). The user
// makes one token per API client (each script or assistant, on each machine) and revokes it
// here. A new token is shown once, in a themed dialog with Copy, and never
// again: it is held only while that dialog is open, never put in the list,
// and the server never answers it a second time. The list shows each live
// token's name, its first 8 characters and when it was last used. Revoking
// asks first, in a themed dialog, since it cannot be undone. While a create
// runs, the Create token button stays focusable: marked aria-disabled, it
// ignores a press (and Enter in the name), and never takes the disabled
// attribute, so a create that fails leaves focus on it. After a revoke,
// focus goes to the next row's Revoke, else the previous row's, else the
// Create token button (useRowFocus in ./focus).
//
// Issue #322: each row says who made the token (the name, else the OIDC
// subject, of the session that made it), or that its maker is unknown for a
// token made before Platehouse recorded that. A new token needs a recent
// sign-in; when the server refuses one with sign_in_required, the page says
// so with a Sign in again link to the login, which comes back here. Sign out
// everywhere sits below the list, and the list is read again after it
// revokes someone's tokens.
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { useI18n } from "../i18n/I18n";
import { AppApiError, appApi, segment, useAppApi, useErrorText } from "./api";
import { ConfirmDialog, Dialog } from "./Dialog";
import { useRowFocus } from "./focus";
import { SignOutEverywhere } from "./SignOutEverywhere";

/** Who made a token: the OIDC subject and the display name the session had then. */
export interface TokenCreator {
  subject: string;
  name: string | null;
}

/** A live token as the list shows it. */
export interface ListedToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Null for a token made before Platehouse recorded who made it. */
  createdBy: TokenCreator | null;
}

/**
 * The login that comes back to Settings, for a fresh sign-in. Fixed here
 * rather than read from the refusal, so an answer can never send the browser
 * anywhere else.
 */
export const SIGN_IN_AGAIN_URL = "/auth/login?next=/settings";

/** True for the server's refusal of a new token from an older sign-in. */
function needsSignIn(failure: unknown): boolean {
  return (
    failure instanceof AppApiError &&
    failure.status === 403 &&
    (failure.body as { error?: unknown } | null)?.error === "sign_in_required"
  );
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
  const { t } = useI18n();
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
    <Dialog title={t("tokens.newTitle")} onClose={onDone} returnFocusTo={returnFocusTo}>
      <p>{t("tokens.showOnce", { name })}</p>
      <code className="ph-token-value">{value}</code>
      <p role="status">
        {copy === "copied" ? t("tokens.copied") : null}
        {copy === "failed" ? t("tokens.copyFailed") : null}
      </p>
      <div className="studio-actions">
        <button type="button" className="studio-button studio-button-primary" onClick={copyValue}>
          {copy === "copied" ? t("tokens.copiedButton") : t("tokens.copy")}
        </button>
        <button type="button" className="studio-button" onClick={onDone}>
          {t("tokens.done")}
        </button>
      </div>
    </Dialog>
  );
}

export function Tokens() {
  const { t, rich, fmt } = useI18n();
  const errorText = useErrorText();
  const nameId = useId();
  const list = useAppApi<{ tokens: ListedToken[] }>("/tokens");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** True after a create refused for an older sign-in: the page offers Sign in again. */
  const [signInNeeded, setSignInNeeded] = useState(false);
  /** The new token, held only while its dialog is open. */
  const [created, setCreated] = useState<{ name: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<ListedToken | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const revokeReturn = useRef<HTMLElement | null>(null);
  const rows = list.data?.tokens ?? [];
  const focus = useRowFocus(
    rows.map((r) => r.id),
    createButton,
  );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("tokens.nameNeeded"));
      return;
    }
    setBusy(true);
    setError(undefined);
    setSignInNeeded(false);
    try {
      const answer = await appApi<CreatedAnswer>("POST", "/tokens", { name: trimmed });
      // Only the listed fields go into the list; the token stays in the dialog.
      const row: ListedToken = {
        id: answer.id,
        name: answer.name,
        prefix: answer.prefix,
        createdAt: answer.createdAt,
        lastUsedAt: answer.lastUsedAt,
        createdBy: answer.createdBy,
      };
      list.set((prev) => ({ tokens: [row, ...prev.tokens.filter((r) => r.id !== row.id)] }));
      setName("");
      setCreated({ name: answer.name, value: answer.token });
    } catch (failure) {
      if (needsSignIn(failure)) setSignInNeeded(true);
      else setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(item: ListedToken) {
    await appApi("DELETE", `/tokens/${segment(item.id)}`);
    // Its own button is gone with it; the dialog hands focus to its neighbour.
    revokeReturn.current = focus.after(item.id);
    list.set((prev) => ({ tokens: prev.tokens.filter((r) => r.id !== item.id) }));
    setRevoking(null);
  }

  return (
    <>
      <div className="ph-section">
        <h2>{t("tokens.heading")}</h2>
        <p className="studio-muted">
          {rich(
            "tokens.intro",
            {},
            { link: (children) => <Link to="/settings?view=api">{children}</Link> },
          )}
        </p>
        <form className="ph-inline-form" onSubmit={create}>
          <label htmlFor={nameId}>{t("tokens.nameLabel")}</label>
          <input
            id={nameId}
            className="studio-input"
            value={name}
            maxLength={MAX_NAME}
            autoComplete="off"
            placeholder={t("tokens.namePlaceholder")}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <button ref={createButton} type="submit" className="studio-button" aria-disabled={busy}>
            {t("tokens.create")}
          </button>
        </form>
        {error === undefined ? null : (
          <p role="alert" className="studio-alert studio-alert-alert">
            {error}
          </p>
        )}
        {signInNeeded ? (
          <p role="alert" className="studio-alert studio-alert-alert">
            {t("tokens.signInRequired")} <a href={SIGN_IN_AGAIN_URL}>{t("tokens.signInAgain")}</a>
          </p>
        ) : null}
        {list.error === undefined ? null : (
          <p className="studio-alert studio-alert-alert">{list.error}</p>
        )}
        {list.data === undefined && list.error === undefined ? (
          <p className="studio-muted">{t("tokens.loading")}</p>
        ) : null}
        {list.data !== undefined && rows.length === 0 ? (
          <p className="studio-empty">{t("tokens.none")}</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="studio-list">
            {rows.map((item) => (
              <li key={item.id} className="studio-list-item" onFocus={focus.focusIn(item.id)}>
                <div className="studio-row">
                  <strong>{item.name}</strong>
                  <button
                    ref={focus.control(item.id)}
                    type="button"
                    className="studio-button ph-small ph-button-danger"
                    aria-label={t("tokens.revokeLabel", { name: item.name })}
                    onClick={() => {
                      revokeReturn.current = focus.get(item.id);
                      setRevoking(item);
                    }}
                  >
                    {t("tokens.revoke")}
                  </button>
                </div>
                <span className="studio-muted">
                  {item.lastUsedAt === null
                    ? rich(
                        "tokens.rowNeverUsed",
                        { prefix: item.prefix, made: fmt.date(item.createdAt) },
                        {
                          code: (children) => <code>{children}</code>,
                          made: (children) => <time dateTime={item.createdAt}>{children}</time>,
                        },
                      )
                    : rich(
                        "tokens.rowUsed",
                        {
                          prefix: item.prefix,
                          made: fmt.date(item.createdAt),
                          used: fmt.date(item.lastUsedAt, true),
                        },
                        {
                          code: (children) => <code>{children}</code>,
                          made: (children) => <time dateTime={item.createdAt}>{children}</time>,
                          used: (children) => (
                            <time dateTime={item.lastUsedAt as string}>{children}</time>
                          ),
                        },
                      )}
                </span>
                <span className="studio-muted" data-token-maker>
                  {item.createdBy === null
                    ? t("tokens.madeByUnknown")
                    : t("tokens.madeBy", { name: item.createdBy.name ?? item.createdBy.subject })}
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
            title={t("tokens.revokeTitle")}
            message={t("tokens.revokeMessage", { name: revoking.name })}
            confirmLabel={t("tokens.revoke")}
            onConfirm={() => revoke(revoking)}
            onCancel={() => setRevoking(null)}
            returnFocusTo={revokeReturn}
          />
        )}
      </div>
      <SignOutEverywhere onTokensRevoked={() => void list.reload()} />
    </>
  );
}
