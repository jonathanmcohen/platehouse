# Organising

## Search

The search box in the top bar searches model names, captions, creators and tags, best match first.
A search always looks through the whole library: typing one while a tag filter is on turns the tag
filter off. A creator or collection filter opened from **Show in the library** stays on.

## Tags

Add and remove tags on a model from its row on the **Tags**, **Creators** or **Collections**
pages, or through the API. To tag many models at once, use Select mode's **Add tags** and
**Remove tag** (see [Selecting several models](./index.md#selecting-several-models)). Tags ignore
case: adding `PLA` when `pla` exists uses the name already stored. Filter the library by a tag with
the tag chips above the cards. The **Tags** page lists every tag with its number of models outside
the trash. A tag that only models in the trash have is not listed; it comes back with them when
they are restored.

When you take a tag off its last model, in the app, the tag is removed too: by **Remove tag** on a
model's row, by Select mode's **Remove tag**, or when the last model that has it is deleted for good
from the trash. A model in the trash still has its tags, so a tag it has is kept. Adding the same
name again later makes the tag again. Taking a tag off a model through the API leaves the tag in
place, with 0 models, because the API never deletes anything.

To delete a tag, press **Delete** beside it on the **Tags** page. If models still have the tag,
Platehouse first asks, saying how many. Deleting a tag takes it off every model that has it,
including models in the trash. The models themselves, their files and their other tags and
collections are not changed.

## Collections

A collection is a named group of models. A model can be in more than one collection, and
collections are flat: a collection cannot contain another. The **Collections** page lists each one
with its models, including an empty one, shown with 0 models; a collection that only models in the
trash are in is not listed. **Show in the library** opens the library filtered to that collection;
**Clear** removes the filter.

A collection is never removed on its own: it stays, empty, when its last model leaves it. To delete
one, press **Delete** beside it on the **Collections** page, or **Delete collection** on the
collection's own page. If models are still in it, Platehouse first asks, saying how many. Deleting a
collection takes every model out of it, including models in the trash, and changes nothing else
about them.

## Creators

A model's creator usually comes from MakerWorld details in the `.3mf`, or from the API. The
**Creators** page lists every creator with their models, and **Show in the library** filters the
library to one creator.

## Renaming

To rename a model, open its page and press **Rename** beside its name at the top. The name turns
into a text field: type the new name, up to 500 characters, and press **Save**, or **Cancel** to
keep the old one. The new name shows at once, in the library and in search.

You can also rename a model, and any of its files, from its row on the **Tags**, **Creators** and
**Collections** pages.

- A rename changes only the name Platehouse shows. The file in the bucket keeps its key, and a
  download still uses the file's real extension.
- A model you have renamed counts as named by you, so neither a file's title nor
  [Use file titles](./settings.md#model-names) ever replaces your name.

## From the API

The API can search, add and remove tags, and add a model to or remove it from a collection. It
cannot delete or trash anything: deleting a tag or a collection is only in the app. See the
[API guide](../api.md).
