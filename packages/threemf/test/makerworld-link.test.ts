import { describe, expect, it } from "vitest";
import { makerWorldDesignId, makerWorldUrl } from "../src/makerworld-link.js";

// The MakerWorld design ID a .3mf carries in 3D/3dmodel.model, as Bambu
// Studio reads it (bbs_3mf.cpp: BBL_DESIGN_ID_TAG = "DesignId"). Every value
// here is synthetic.
const prefix = (designId: string) => `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US">
 <metadata name="Designer">Example Designer</metadata>
 <metadata name="DesignId">${designId}</metadata>
 <metadata name="Title">Example Kit</metadata>
 `;

describe("makerWorldDesignId", () => {
  it("reads a numeric DesignId", () => {
    expect(makerWorldDesignId(prefix("1234567"))).toBe("1234567");
  });

  it("trims spaces around the id", () => {
    expect(makerWorldDesignId(prefix("  1234567 \n"))).toBe("1234567");
  });

  it("is null when the file has no DesignId", () => {
    expect(makerWorldDesignId('<metadata name="Designer">D</metadata>')).toBeNull();
    expect(makerWorldDesignId("")).toBeNull();
  });

  it("is null for an empty or self-closing DesignId", () => {
    expect(makerWorldDesignId(prefix(""))).toBeNull();
    expect(makerWorldDesignId('<metadata name="DesignId"/>')).toBeNull();
  });

  it.each([
    ["letters", "abc123"],
    ["a leading zero", "0123"],
    ["zero", "0"],
    ["a negative number", "-5"],
    ["a decimal", "12.5"],
    ["an exponent", "1e9"],
    ["more than 15 digits", "1234567890123456"],
    ["digits with a space inside", "123 456"],
    ["a path", "123/../../evil"],
    ["a javascript URL", "javascript:alert(1)"],
    ["another host", "https://evil.example/models/123"],
    ["a look-alike host", "https://makerworld.com.evil.example/models/123"],
    ["a user-info trick", "https://makerworld.com@evil.example/models/123"],
    ["plain http", "http://makerworld.com/models/123"],
    ["a MakerWorld page that is not a model", "https://makerworld.com/en/@someone"],
    ["an escaped tag", "&lt;script&gt;"],
  ])("refuses %s", (_label, value) => {
    expect(makerWorldDesignId(prefix(value))).toBeNull();
  });

  it.each([
    ["https://makerworld.com/models/1234567", "1234567"],
    ["https://makerworld.com/en/models/1234567", "1234567"],
    ["https://makerworld.com/de/models/1234567-example-kit", "1234567"],
    ["https://makerworld.com/en/models/1234567?from=search#profileId-99", "1234567"],
    ["https://www.makerworld.com/en/models/1234567", "1234567"],
  ])("takes the id from a known MakerWorld model URL %s", (value, id) => {
    expect(makerWorldDesignId(prefix(value))).toBe(id);
  });

  it("decodes an entity-escaped URL before checking it", () => {
    expect(makerWorldDesignId(prefix("https://makerworld.com/en/models/42?a=1&amp;amp;b=2"))).toBe(
      "42",
    );
  });

  it("takes the first DesignId when there are two", () => {
    expect(
      makerWorldDesignId(
        '<metadata name="DesignId">111</metadata><metadata name="DesignId">222</metadata>',
      ),
    ).toBe("111");
  });

  it("accepts single quotes and spacing around the name", () => {
    expect(makerWorldDesignId("<metadata  name = 'DesignId' >77</metadata >")).toBe("77");
  });

  it("does not read a DesignUserId or DesignerUserId as the design id", () => {
    expect(makerWorldDesignId('<metadata name="DesignerUserId">555</metadata>')).toBeNull();
    expect(makerWorldDesignId('<metadata name="DesignIdX">555</metadata>')).toBeNull();
  });

  it("a long DesignId value is refused, not cut", () => {
    expect(makerWorldDesignId(prefix(`1${"0".repeat(400)}`))).toBeNull();
  });

  it("time grows linearly on a prefix of many metadata tags that are not DesignId", () => {
    // Every unit starts a <metadata tag the scan has to look at and pass over.
    // A DesignId unit would not do: the first one ends the scan at once,
    // whatever the input size (issue #253).
    const unit = '<metadata name="Other">x';
    const time = (n: number) => {
      const xml = unit.repeat(n);
      const start = performance.now();
      expect(makerWorldDesignId(xml)).toBeNull();
      return performance.now() - start;
    };
    time(1000);
    const small = time(4000);
    const large = time(16000);
    // Four times the input; a quadratic scan would take about sixteen times
    // as long. The bound is loose so a busy machine does not fail it.
    expect(large).toBeLessThan(Math.max(small, 1) * 10);
  });
});

describe("makerWorldUrl", () => {
  it("builds the model page URL from a valid id", () => {
    expect(makerWorldUrl("1234567")).toBe("https://makerworld.com/models/1234567");
  });

  it.each([[null], [""], ["0"], ["abc"], ["12/../3"], ["1234567890123456"]])(
    "is null for %s",
    (id) => {
      expect(makerWorldUrl(id)).toBeNull();
    },
  );
});
