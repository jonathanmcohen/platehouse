// The Trash page, /trash (build plan Task 21; AC-063 UI): the trash list
// with Restore, the purge date per model and Empty trash.
import { TrashList } from "./TrashList";

export function TrashPage() {
  return (
    <>
      <div className="studio-page-head">
        <h1>Trash</h1>
      </div>
      <TrashList />
    </>
  );
}
