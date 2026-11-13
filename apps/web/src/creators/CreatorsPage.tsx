// The Creators page, /creators (build plan Task 21): every creator with how
// many models they made, and each creator's models, ready to organise.
import { GroupPage } from "../collections/GroupPage";

export function CreatorsPage() {
  return (
    <GroupPage
      title="Creators"
      listPath="/creators"
      filter="creator"
      emptyText="No creators yet. A creator is read from a model's MakerWorld details."
    />
  );
}
