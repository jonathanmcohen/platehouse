// MakerWorld details from a .3mf, its description as Markdown, the licence
// map, and the sanitising Markdown renderer.
export { extractMakerWorld, type MakerWorldDetails } from "./extract.js";
export { type LicenseMapping, mapLicense } from "./license.js";
export {
  CONVERTER_VERSION,
  earlierConversions,
  htmlToMarkdown,
  renderMarkdown,
} from "./markdown.js";
