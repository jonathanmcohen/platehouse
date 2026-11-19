// Platehouse's translations (Jon, 2026-11-19): the message format, the
// catalog check, language negotiation and the translator, shared by the web
// app, the server and the CI check. The catalogs are the JSON files in
// ../locales; English (en.json) is the source of truth. Node-only helpers
// (reading the catalog folder) are in ./node, so the web bundle never
// imports node: modules.
export {
  formatDateTime,
  formatDecimal,
  formatList,
  languageName,
} from "./format.js";
export {
  formatMessage,
  formatNodes,
  type MessageNode,
  MessageSyntaxError,
  type MessageShape,
  type MessageValue,
  type MessageValues,
  messageShape,
  PLURAL_CATEGORIES,
  parseMessage,
  pluralCase,
  type Renderer,
  renderMessage,
} from "./message.js";
export {
  canonicalLocale,
  LANG_COOKIE,
  matchLocale,
  parseAcceptLanguage,
  resolveLocale,
  SOURCE_LOCALE,
} from "./negotiate.js";
export {
  englishPrinterName,
  OTHER_PRINTER_LABEL,
  PRINTER_NAME,
  parsePrinterName,
} from "./printers.js";
export { createTranslator, MISSING_TEXT, type Translator } from "./translator.js";
export {
  type CatalogMeta,
  type CatalogProblem,
  type CheckedCatalog,
  checkCatalog,
  checkEnglish,
  MAX_MESSAGE,
  META_KEY,
  type Messages,
  messagesOf,
  pluralCategories,
} from "./validate.js";
