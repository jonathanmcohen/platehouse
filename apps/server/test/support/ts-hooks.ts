// Lets plain Node run the server from its TypeScript source, for the test
// that starts src/main.ts as a real process and sends it SIGTERM (build plan
// Task 30). Node 26 strips the types itself (the workspace is
// erasableSyntaxOnly) and --conditions=source picks the workspace packages'
// source; what it does not do is find a .ts file under the .js name the
// imports use (nodenext style). This hook retries a relative .js import that
// was not found as the .ts file beside it. Test-only: the app image (Task 24)
// runs the built JavaScript.
//
//   node --conditions=source --import <this file> apps/server/src/main.ts
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const notFound = (error as { code?: string } | null)?.code === "ERR_MODULE_NOT_FOUND";
      if (notFound && specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
