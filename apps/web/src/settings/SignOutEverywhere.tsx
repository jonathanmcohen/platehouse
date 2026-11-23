// Sign out everywhere on the settings page (issue #322). It lists everyone
// with a live session or a live API token they made (GET /app/api/users),
// each with how many of each, and the signed-in user first, marked (you).
// Sign out asks first, in the app's themed dialog, since it cannot be
// undone: it ends every session of that person (POST /app/api/users/sign-out),
// and with the box ticked also revokes every API token they made. The box
// starts unticked, so revoking a person's scripts is always a choice. A
// token whose maker is unknown is never revoked here; the token list above
// shows those, to revoke by hand.
//
// Every signed-in user may use it, but signing someone else out needs a
// sign-in in the last few minutes: the server refuses it otherwise with
// sign_in_required, and the page says so with a Sign in again link. After a
// change the status line says what was ended, the list is read again, and so
// is the token list (onTokensRevoked) when tokens were revoked. Signing yourself out
// everywhere ends this session too, so the page says so and offers a Sign in
// link instead of reading the list again. Focus goes to the section heading
// after the dialog closes, since the row's own button may be gone.
//
// A person is always named with their OIDC subject beside their name, in the
// row, the button label, the confirmation and the status line (PR #364
// review): display names come from the issuer and need not be unique, and
// signing out the wrong person, or revoking their tokens, cannot be undone.
import { Fragment, type ReactNode, useId, useRef, useState } from "react";
import { type I18n, useI18n } from "../i18n/I18n";
import { appApi, needsSignIn, SIGN_IN_AGAIN_URL, useAppApi } from "./api";
import { ConfirmDialog } from "./Dialog";

/** One user as GET /app/api/users lists them. */
export interface KnownUser {
  subject: string;
  name: string | null;
  sessions: number;
  tokens: number;
  /** The signed-in user. */
  you: boolean;
}

interface SignOutAnswer {
  sessionsEnded: number;
  tokensRevoked: number;
}

/** First strong isolate and pop directional isolate, around a name in plain text. */
const ISOLATE_START = "\u2068";
const ISOLATE_END = "\u2069";

/**
 * How a person is named in Settings: their name with their OIDC subject
 * beside it, so two people with the same name can be told apart, else the
 * subject alone. The name is isolated (first strong isolate to pop
 * directional isolate), so a name written right to left, or one with an
 * unclosed direction control, cannot reorder the user id after it. The
 * token list's "Made by" line, the button's label, the confirmation and the
 * status line use it; the list row isolates the name with a <bdi> instead.
 */
export function userLabel(t: I18n["t"], user: { subject: string; name: string | null }): string {
  return user.name === null
    ? user.subject
    : t("settings.userWithId", {
        name: `${ISOLATE_START}${user.name}${ISOLATE_END}`,
        subject: user.subject,
      });
}

/** Stands for the name while a sentence is split around it; never shown. */
const NAME_MARK = "\u0000";

/**
 * A person as the list's row shows them, the same words as userLabel and
 * "(you)", with the name alone inside a <bdi>: a name written in the other
 * direction cannot then reorder the user id or "(you)" beside it. The
 * translations keep their own word order: the name's place is found by
 * writing the sentence once with a mark where it goes.
 */
function UserName({ user }: { user: KnownUser }): ReactNode {
  const { t } = useI18n();
  if (user.name === null) {
    const label = userLabel(t, user);
    return user.you ? t("signOut.you", { name: label }) : label;
  }
  const withMark = t("settings.userWithId", { name: NAME_MARK, subject: user.subject });
  const sentence = user.you ? t("signOut.you", { name: withMark }) : withMark;
  const parts = sentence.split(NAME_MARK);
  return parts.map((part, index) => (
    // The parts never change order, so their index is a stable key.
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed split of one sentence
    <Fragment key={index}>
      {index > 0 ? <bdi>{user.name}</bdi> : null}
      {part}
    </Fragment>
  ));
}

export function SignOutEverywhere({ onTokensRevoked }: { onTokensRevoked(): void }) {
  const { t } = useI18n();
  const list = useAppApi<{ users: KnownUser[] }>("/users");
  const [asking, setAsking] = useState<KnownUser | null>(null);
  const [revokeTokens, setRevokeTokens] = useState(false);
  const [status, setStatus] = useState<{ text: string; self: boolean } | null>(null);
  /** True after a sign-out of someone else refused for an older sign-in. */
  const [signInNeeded, setSignInNeeded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const boxId = useId();
  const users = list.data?.users ?? [];

  function shown(user: KnownUser): string {
    const label = userLabel(t, user);
    return user.you ? t("signOut.you", { name: label }) : label;
  }

  async function signOut(user: KnownUser) {
    setSignInNeeded(false);
    let answer: SignOutAnswer;
    try {
      answer = await appApi<SignOutAnswer>("POST", "/users/sign-out", {
        subject: user.subject,
        revokeTokens,
      });
    } catch (failure) {
      if (!needsSignIn(failure)) throw failure;
      // Signing someone else out needs a recent sign-in: close the dialog and
      // offer the sign-in; nothing was ended.
      setAsking(null);
      setStatus(null);
      setSignInNeeded(true);
      return;
    }
    setAsking(null);
    if (user.you) {
      setStatus({ text: t("signOut.doneSelf"), self: true });
      return;
    }
    const values = {
      name: userLabel(t, user),
      sessions: answer.sessionsEnded,
      tokens: answer.tokensRevoked,
    };
    setStatus({
      text: revokeTokens ? t("signOut.doneRevoked", values) : t("signOut.done", values),
      self: false,
    });
    if (answer.tokensRevoked > 0) onTokensRevoked();
    await list.reload();
  }

  return (
    <div className="ph-section">
      <h2 ref={heading} tabIndex={-1}>
        {t("signOut.heading")}
      </h2>
      <p className="studio-muted">{t("signOut.intro")}</p>
      <p role="status" data-sign-out-status>
        {status === null ? null : status.text}
        {status?.self === true ? (
          <>
            {" "}
            <a href="/auth/login">{t("signOut.signIn")}</a>
          </>
        ) : null}
      </p>
      {signInNeeded ? (
        <p role="alert" className="studio-alert studio-alert-alert" data-sign-out-refused>
          {t("signOut.signInRequired")} <a href={SIGN_IN_AGAIN_URL}>{t("signOut.signInAgain")}</a>
        </p>
      ) : null}
      {list.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{list.error}</p>
      )}
      {list.data === undefined && list.error === undefined ? (
        <p className="studio-muted">{t("signOut.loading")}</p>
      ) : null}
      {list.data !== undefined && users.length === 0 ? (
        <p className="studio-empty">{t("signOut.none")}</p>
      ) : null}
      {users.length > 0 ? (
        <ul className="studio-list">
          {users.map((user) => (
            <li key={user.subject} className="studio-list-item">
              <div className="studio-row">
                <strong>
                  <UserName user={user} />
                </strong>
                <button
                  type="button"
                  className="studio-button ph-small ph-button-danger"
                  aria-label={t("signOut.buttonLabel", { name: shown(user) })}
                  onClick={() => {
                    setRevokeTokens(false);
                    setAsking(user);
                  }}
                >
                  {t("signOut.button")}
                </button>
              </div>
              <span className="studio-muted">
                {t("signOut.counts", { sessions: user.sessions, tokens: user.tokens })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {asking === null ? null : (
        <ConfirmDialog
          title={t("signOut.confirmTitle")}
          message={t("signOut.confirmMessage", { name: shown(asking) })}
          confirmLabel={t("signOut.confirm")}
          onConfirm={() => signOut(asking)}
          onCancel={() => setAsking(null)}
          returnFocusTo={heading}
        >
          <p>
            <input
              id={boxId}
              type="checkbox"
              checked={revokeTokens}
              onChange={(event) => setRevokeTokens(event.currentTarget.checked)}
            />{" "}
            <label htmlFor={boxId}>{t("signOut.revokeTokens", { tokens: asking.tokens })}</label>
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
