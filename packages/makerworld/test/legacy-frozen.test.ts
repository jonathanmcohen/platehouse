import { describe, expect, it } from "vitest";
import { earlierConversions } from "../src/index.js";

// Outputs recorded from the converters before their entity helpers were
// copied into legacy/entities.ts. Versions 1 to 3 must keep giving exactly
// these, whatever happens to the live helpers.
describe("the frozen converters give exactly their recorded output", () => {
  const same = (markdown: string) => [
    { version: 1, markdown },
    { version: 2, markdown },
    { version: 3, markdown },
  ];

  it("decodes entities as they always did", () => {
    expect(
      earlierConversions("<p>Fish &amp; chips &copy; &#8212; &unknown; &#x1F600; &#0;</p>"),
    ).toEqual(same("Fish & chips \u00a9 \u2014 &unknown; \u{1F600} &#0;"));
  });

  it("keeps nested blocks apart", () => {
    expect(
      earlierConversions(
        "<div><p>One</p><blockquote><p>Two <b>bold</b></p><ul><li>a &lt;b&gt;</li><li><p>c</p></li></ul></blockquote></div><p>End</p>",
      ),
    ).toEqual(same("One\n\nTwo **bold**\n\n- a \\<b\\>\n- c\n\nEnd"));
  });

  it("treats an unknown tag as the earlier versions did", () => {
    expect(
      earlierConversions(
        "<p>Before</p><mw-box>Membership</mw-box><custom-el><span>Hi</span></custom-el>after",
      ),
    ).toEqual(same("Before\n\nMembershipHiafter"));
  });
});
