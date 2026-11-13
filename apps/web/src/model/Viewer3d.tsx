// The 3D viewer (build plan Task 20, AC-050). Interface stub.

export interface ThreeSource {
  kind: "stl" | "glb";
  url: string;
}

export interface ViewerHandle {
  rotate(radians: number): void;
  zoom(factor: number): void;
  reset(): void;
  dispose(): void;
}

export interface ThreeViewer {
  show(el: HTMLElement, source: ThreeSource, signal?: AbortSignal): Promise<ViewerHandle>;
}

export type ThreeLoader = () => Promise<ThreeViewer>;
