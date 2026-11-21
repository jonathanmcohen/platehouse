// The recorded Manyfold OpenAPI the stub is built from, and the checker the
// stub runs every body through. If the checker could not fail, the stub's
// "conforms to the document" would mean nothing, so it is shown failing.
import { describe, expect, it } from "vitest";
import { check, OPENAPI_SHA256, openapiSha256, responseSchema } from "./support/openapi.js";

describe("the recorded document", () => {
  it("is Manyfold v0.154.1's app/api/v0/openapi.json, unchanged", () => {
    expect(openapiSha256).toBe(OPENAPI_SHA256);
  });
});

describe("the checker", () => {
  const file = {
    "@context": ["https://schema.org/"],
    "@id": "https://m.example.test/models/a/model_files/b",
    "@type": "3DModel",
    encodingFormat: "model/3mf",
    isPartOf: { "@id": "https://m.example.test/models/a" },
    contentSize: 12,
  };

  it("passes a body that follows the document", () => {
    expect(check(responseSchema("/models/{model_id}/model_files/{id}"), file)).toEqual([]);
  });

  it("names a missing required field", () => {
    const { isPartOf: _gone, ...broken } = file;
    expect(check(responseSchema("/models/{model_id}/model_files/{id}"), broken)).toEqual([
      "$: missing required isPartOf",
    ]);
  });

  it("names a field of the wrong type, through a $ref", () => {
    expect(
      check(responseSchema("/models/{model_id}/model_files/{id}"), { ...file, contentSize: "12" }),
    ).toEqual(["$.contentSize: string, documented as integer"]);
  });

  it("checks list items", () => {
    const body = {
      "@context": [],
      "@id": "x",
      "@type": "hydra:Collection",
      totalItems: 1,
      member: [{ "@id": "/models/a" }],
      view: { "@id": "x", "@type": "y", first: "f", last: "l" },
    };
    expect(check(responseSchema("/models"), body)).toEqual(["$.member[0]: missing required name"]);
  });
});
