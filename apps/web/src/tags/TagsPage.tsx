// The Tags page, /tags (build plan Task 21; AC-061): every tag with how many
// models carry it, and each tag's models with their chips.
import { GroupPage } from "../collections/GroupPage";

export function TagsPage() {
  return (
    <GroupPage
      title="Tags"
      listPath="/tags"
      filter="tag"
      emptyText="No tags yet. Add a tag to a model to make one."
    />
  );
}
