// The Collections page, /collections (build plan Task 21; AC-062).
// Collections are flat; a model can sit in more than one, and a collection
// is made the first time a model is added to it.
import { GroupPage } from "./GroupPage";

export function CollectionsPage() {
  return (
    <GroupPage
      title="Collections"
      listPath="/collections"
      filter="collection"
      emptyText="No collections yet. Add a model to a collection to make one."
    />
  );
}
