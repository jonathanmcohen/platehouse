# API

Added in 0.1.0. The full API guide is being added in a separate change and will appear here once it
is merged.

Until then, in short:

- The API lives under `/api/v1/` and takes a bearer token from **Settings**
  (`Authorization: Bearer <token>`). See [Security](./security.md#api-tokens).
- It describes itself in OpenAPI at `/api/v1/openapi.json`.
- It can search the library, read models, files and plates, download files, upload files with the
  same resumable upload the web app uses (a file the library already holds is stored again unless
  the upload sets `duplicates` to `skip`), and add and remove tags and collection memberships. It
  cannot delete, trash or purge anything.
