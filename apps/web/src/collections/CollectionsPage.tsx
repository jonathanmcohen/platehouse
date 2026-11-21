// The Collections page, /collections (build plan Task 21; AC-062).
// Collections are flat; a model can sit in more than one, and a collection
// is made the first time a model is added to it.
import { useI18n } from "../i18n/I18n";
import { GroupPage } from "./GroupPage";

export function CollectionsPage() {
  const { t } = useI18n();
  return (
    <GroupPage
      title={t("shell.nav.collections")}
      listPath="/collections"
      filter="collection"
      emptyText={t("groups.collections.empty")}
    />
  );
}
