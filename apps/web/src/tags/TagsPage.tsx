// The Tags page, /tags (build plan Task 21; AC-061): every tag with how many
// models carry it, and each tag's models with their chips.

import { GroupPage } from "../collections/GroupPage";
import { useI18n } from "../i18n/I18n";

export function TagsPage() {
  const { t } = useI18n();
  return (
    <GroupPage
      title={t("shell.nav.tags")}
      listPath="/tags"
      filter="tag"
      emptyText={t("groups.tags.empty")}
    />
  );
}
