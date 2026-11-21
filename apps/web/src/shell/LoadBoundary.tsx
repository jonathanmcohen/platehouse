// Catches an error thrown while rendering what it wraps and shows fallback
// in its place, so one part that fails, such as a lazily loaded view whose
// chunk cannot be fetched, never unmounts the whole app. React offers this
// only as a class component (getDerivedStateFromError). React still reports
// the error on the console. It stays on the fallback until it unmounts: a
// lazy component whose import failed fails again on every render, and a
// reload is what fetches the new chunk.
import { Component, type ReactNode } from "react";

export interface LoadBoundaryProps {
  /** What to show once something inside has failed. */
  fallback: ReactNode;
  children: ReactNode;
}

export class LoadBoundary extends Component<LoadBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
