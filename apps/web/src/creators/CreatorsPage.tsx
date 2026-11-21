// The Creators page, /creators (build plan Task 21): every creator with how
// many models they made, and each creator's models, ready to organise.

import { GroupPage } from "../collections/GroupPage";
import { useI18n } from "../i18n/I18n";

export function CreatorsPage() {
  const { t } = useI18n();
  return (
    <GroupPage
      title={t("shell.nav.creators")}
      listPath="/creators"
      filter="creator"
      emptyText={t("groups.creators.empty")}
    />
  );
}
