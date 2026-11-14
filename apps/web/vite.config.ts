// The web app's build (build plan Task 18). vite build writes index.html and
// the hashed /assets/ files into dist/, which the server serves
// (apps/server/src/web/shell.ts): index.html as the shell page, with
// data-theme and the color-scheme meta written in from the ph_theme cookie,
// and dist/assets/ under /assets/. tsc -b only type-checks this package
// (noEmit), so nothing but Vite writes into dist/.
//
// Workspace packages (the model page's renderMarkdown from
// @platehouse/makerworld, Task 20) export their TypeScript source under the
// "source" condition, as vitest.config.ts reads them, so the build takes
// that source and does not need the package's dist/ built first.
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["source", ...defaultClientConditions],
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
  },
});
