// The 3D viewer (build plan Task 20, AC-050): an STL or a GLB (a STEP file's
// mesh, converted on the server by Task 13) shown with three.js, which the
// pointer rotates, pans and zooms (OrbitControls) and buttons rotate, zoom
// and reset, so it works by keyboard too.
//
// three.js is loaded only when this viewer is shown (a dynamic import, so
// Vite puts it in its own chunk) and only for an STL or a GLB; a .3mf never
// gets here (AC-051). The loader is a prop so the tests, which run in jsdom
// with no WebGL, can stand in for it. The mesh is fetched from /blobs/<id>
// with the page's session, and the fetch is aborted when the viewer goes.
// If anything fails (no WebGL, the store unavailable), the viewer says so
// and offers the file's download instead.
import { useEffect, useRef, useState } from "react";

export interface ThreeSource {
  kind: "stl" | "glb";
  url: string;
}

/** What the viewer's buttons drive once the model is on screen. */
export interface ViewerHandle {
  /** Turns the model about the vertical axis; positive is to the right. */
  rotate(radians: number): void;
  /** Moves the camera toward (factor below 1) or away from the model. */
  zoom(factor: number): void;
  /** Back to the first view. */
  reset(): void;
  /** Stops drawing and frees the WebGL context. */
  dispose(): void;
}

export interface ThreeViewer {
  show(el: HTMLElement, source: ThreeSource, signal?: AbortSignal): Promise<ViewerHandle>;
}

export type ThreeLoader = () => Promise<ThreeViewer>;

/** How far one press of Rotate turns the model: 22.5 degrees. */
export const ROTATE_STEP = Math.PI / 8;

/** How much one press of Zoom moves the camera. */
export const ZOOM_STEP = 0.8;

/**
 * three.js and its STL, GLTF and orbit-control add-ons, imported only now.
 * The modules are untyped (three.d.ts), so this one function is the only
 * code that touches them.
 */
export const defaultLoadThree: ThreeLoader = async () => {
  const [THREE, stlModule, gltfModule, orbitModule] = await Promise.all([
    import("three"),
    import("three/addons/loaders/STLLoader.js"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/controls/OrbitControls.js"),
  ]);

  return {
    async show(el, source, signal) {
      const res = await fetch(source.url, {
        credentials: "same-origin",
        ...(signal === undefined ? {} : { signal }),
      });
      if (!res.ok) throw new Error(`the mesh answered ${res.status}`);
      const bytes = await res.arrayBuffer();

      let object: unknown;
      if (source.kind === "stl") {
        const geometry = new stlModule.STLLoader().parse(bytes);
        geometry.computeVertexNormals();
        const accent = getComputedStyle(el).getPropertyValue("--accent").trim();
        const material = new THREE.MeshStandardMaterial({
          ...(accent === "" ? {} : { color: accent }),
          roughness: 0.6,
          metalness: 0.05,
        });
        const mesh = new THREE.Mesh(geometry, material);
        // Print files are Z-up; three.js is Y-up.
        mesh.rotation.x = -Math.PI / 2;
        object = mesh;
      } else {
        object = await new Promise((resolve, reject) => {
          new gltfModule.GLTFLoader().parse(
            bytes,
            "",
            (gltf: { scene: unknown }) => resolve(gltf.scene),
            reject,
          );
        });
      }
      signal?.throwIfAborted();

      const width = el.clientWidth || 640;
      const height = el.clientHeight || 480;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      el.append(renderer.domElement);

      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.position.set(1, 2, 3);
      scene.add(sun);

      // The model is centred in a group that the Rotate buttons turn.
      const frame = new THREE.Group();
      frame.add(object);
      const box = new THREE.Box3().setFromObject(frame);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const holder = new THREE.Group();
      frame.position.sub(centre);
      holder.add(frame);
      scene.add(holder);

      const radius = Math.max(size.x, size.y, size.z, 0.001);
      const camera = new THREE.PerspectiveCamera(40, width / height, radius / 100, radius * 100);
      const home = new THREE.Vector3(radius * 1.1, radius * 0.8, radius * 1.5);
      camera.position.copy(home);
      const controls = new orbitModule.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.set(0, 0, 0);
      controls.update();

      renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
      });
      const resize = new ResizeObserver(() => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === 0 || h === 0) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      });
      resize.observe(el);

      return {
        rotate(radians) {
          holder.rotation.y += radians;
        },
        zoom(factor) {
          camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
          controls.update();
        },
        reset() {
          holder.rotation.y = 0;
          controls.target.set(0, 0, 0);
          camera.position.copy(home);
          controls.update();
        },
        dispose() {
          renderer.setAnimationLoop(null);
          resize.disconnect();
          controls.dispose();
          scene.traverse((node: { geometry?: { dispose(): void }; material?: unknown }) => {
            node.geometry?.dispose();
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of materials) (m as { dispose?: () => void } | undefined)?.dispose?.();
          });
          renderer.dispose();
          renderer.domElement.remove();
        },
      };
    },
  };
};

export interface Viewer3dProps {
  source: ThreeSource;
  /** The file's name, for the view's label. */
  label: string;
  /** The file's download, offered when the view cannot be shown. */
  download: string;
  loadThree?: ThreeLoader | undefined;
}

export function Viewer3d({ source, label, download, loadThree }: Viewer3dProps) {
  const host = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<ViewerHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const { kind, url } = source;

  useEffect(() => {
    let cancelled = false;
    let shown: ViewerHandle | undefined;
    const controller = new AbortController();
    setHandle(null);
    setFailed(false);
    (async () => {
      try {
        const viewer = await (loadThree ?? defaultLoadThree)();
        const el = host.current;
        if (cancelled || el === null) return;
        const made = await viewer.show(el, { kind, url }, controller.signal);
        if (cancelled) {
          made.dispose();
          return;
        }
        shown = made;
        setHandle(made);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      shown?.dispose();
    };
  }, [kind, url, loadThree]);

  function press(action: (h: ViewerHandle) => void) {
    if (handle !== null) action(handle);
  }

  return (
    <>
      <div className="studio-viewer-frame">
        <div
          ref={host}
          className="ph-viewer3d"
          data-viewer3d=""
          role="img"
          aria-label={`3D view of ${label}`}
        />
        {failed ? (
          <p className="studio-placeholder">
            <span>
              The 3D view could not be shown. <a href={download}>Download {label}</a> instead.
            </span>
          </p>
        ) : handle === null ? (
          <p className="studio-placeholder">Loading the 3D view...</p>
        ) : null}
      </div>
      {failed ? null : (
        <fieldset className="studio-actions ph-viewer-controls">
          <legend className="studio-visually-hidden">3D view controls</legend>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.rotate(-ROTATE_STEP))}
          >
            Rotate left
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.rotate(ROTATE_STEP))}
          >
            Rotate right
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.zoom(ZOOM_STEP))}
          >
            Zoom in
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.zoom(1 / ZOOM_STEP))}
          >
            Zoom out
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.reset())}
          >
            Reset view
          </button>
        </fieldset>
      )}
    </>
  );
}
