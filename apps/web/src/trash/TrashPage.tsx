// The Trash page, /trash (build plan Task 21; AC-063 UI): the trash list
// with Restore, the purge date per model and Empty trash.
import { TrashList } from "./TrashList";
import { useI18n } from "../i18n/I18n";

export function TrashPage() {
  const { t } = useI18n();
  return (
    <>
      <div className="studio-page-head">
        <h1>{t("shell.nav.trash")}</h1>
      </div>
      <TrashList />
    </>
  );
}
