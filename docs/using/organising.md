# Organising

## Search

The search box in the top bar searches model names, captions, creators and tags, best match first.

## Tags

Add and remove tags on a model from its row on the **Tags**, **Creators** or **Collections**
pages, or through the API. To tag many models at once, use Select mode's **Add tags** and
**Remove tag** (see [Selecting several models](./index.md#selecting-several-models)). Tags ignore
case: adding `PLA` when `pla` exists uses the name already stored. Filter the library by a tag with
the tag chips above the cards. The **Tags** page lists every tag that at least one model outside
the trash has, with its number of models; a tag that only trashed models have, or that no model
has, is not listed.

## Collections

A collection is a named group of models. A model can be in more than one collection, and
collections are flat: a collection cannot contain another. The **Collections** page lists each one
with its models. **Show in the library** opens the library filtered to that collection; **Clear**
removes the filter.

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
cannot delete or trash anything. See the [API guide](../api.md).
