// Whether the tab is on screen, and work that should only run while it is
// (issue #469): a background tab has nobody to show a poll's answer to.

import { type DependencyList, useEffect } from "react";

export function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Runs start while the tab is visible. start returns what stops its work.
 * When the tab is hidden that is called; when it is visible again, start
 * runs once more with resumed true, so it can catch up before it carries on.
 * Everything stops when the component unmounts or deps change.
 */
export function useWhileVisible(start: (resumed: boolean) => () => void, deps: DependencyList) {
  useEffect(() => {
    let stop: (() => void) | undefined;
    if (!isHidden()) stop = start(false);
    function onVisibility() {
      stop?.();
      stop = undefined;
      if (!isHidden()) stop = start(true);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop?.();
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the caller's, and start is read afresh on each run.
  }, deps);
}
