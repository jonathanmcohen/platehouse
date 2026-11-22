// The 3D viewer (build plan Task 20, AC-050): an STL or a GLB (a STEP file's
// mesh, converted on the server by Task 13) shown with three.js, which the
// pointer rotates, pans and zooms (OrbitControls) and buttons rotate, zoom
// and reset, so it works by keyboard too.
//
// three.js is loaded only when this viewer is shown (a dynamic import, so
// Vite puts it in its own chunk) and only for an STL or a GLB. A .3mf plate
// gets here only once its 3D view is opened (Plate3d, issue #358), with the
// GLB the server made of that plate's objects. The loader is a prop so the
// tests, which run in jsdom with no WebGL, can stand in for it. The mesh is
// fetched from /blobs/<id> with the page's session, and the fetch is aborted
// when the viewer goes. If anything fails (no WebGL, the store unavailable),
// the viewer says so and offers the file's download instead, unless the
// caller handles the failure itself (onFailed, given what was thrown: a
// plate goes back to its picture and says why). A mesh that could not be
// fetched or read is a MeshLoadError carrying the fetch's HTTP status, so
// the caller can tell it from a viewer that cannot start. actions are
// buttons of the caller's, put between the view and its own controls.
import { type ReactNode, useEffect, useRef, useState } from "react";
// A type-only import, erased from the build, so three.js still loads only
// through the dynamic imports in defaultLoadThree.
import type { Object3D } from "three";
import { useI18n } from "../i18n/I18n";

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

/**
 * The mesh could not be fetched or read: status is the HTTP status of a
 * failed fetch, or null when no reply came or the mesh could not be read.
 * Any other failure of show (no WebGL) is not one of these.
 */
export class MeshLoadError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "MeshLoadError";
    this.status = status;
  }
}

/** How far one press of Rotate turns the model: 22.5 degrees. */
export const ROTATE_STEP = Math.PI / 8;

/** How much one press of Zoom moves the camera. */
export const ZOOM_STEP = 0.8;

/**
 * three.js and its STL, GLTF and orbit-control add-ons, imported only now.
 * This one function is the only code that touches them; @types/three types
 * it, and everything outside sees only the ThreeViewer interface.
 */
export const defaultLoadThree: ThreeLoader = async () => {
  const [THREE, stlModule, gltfModule, orbitModule] = await Promise.all([
    import("three"),
    import("three/addons/loaders/STLLoader.js"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/controls/OrbitControls.js"),
  ]);

  /** The model in the mesh's bytes, for the page's element el. */
  async function parse(el: HTMLElement, kind: ThreeSource["kind"], bytes: ArrayBuffer) {
    if (kind === "glb") return (await new gltfModule.GLTFLoader().parseAsync(bytes, "")).scene;
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
    return mesh;
  }

  return {
    async show(el, source, signal) {
      // An abort is passed on as it is; the viewer drops it.
      const meshFailed = (error: unknown, message: string): unknown =>
        signal?.aborted ? error : new MeshLoadError(null, message);
      let res: Response;
      let bytes: ArrayBuffer;
      try {
        res = await fetch(source.url, {
          credentials: "same-origin",
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw meshFailed(error, "the mesh could not be fetched");
      }
      if (!res.ok) throw new MeshLoadError(res.status, `the mesh answered ${res.status}`);
      try {
        bytes = await res.arrayBuffer();
      } catch (error) {
        throw meshFailed(error, "the mesh could not be fetched");
      }

      let object: Object3D;
      try {
        object = await parse(el, source.kind, bytes);
      } catch (error) {
        throw meshFailed(error, "the mesh could not be read");
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
          // Meshes, points, lines and sprites carry a geometry and one or
          // more materials; lights, groups and the scene carry neither.
          scene.traverse((node) => {
            if ("geometry" in node && node.geometry instanceof THREE.BufferGeometry) {
              node.geometry.dispose();
            }
            if ("material" in node) {
              const materials = Array.isArray(node.material) ? node.material : [node.material];
              for (const m of materials) if (m instanceof THREE.Material) m.dispose();
            }
          });
          renderer.dispose();
          renderer.domElement.remove();
        },
      };
    },
  };
};

export interface Viewer3dProps {
  /**
   * What to show; null while the caller is still finding out (a plate's
   * mesh being made), which shows the view loading, three.js not yet loaded.
   */
  source: ThreeSource | null;
  /** The file's name, for the view's label. */
  label: string;
  /** The file's download, offered when the view cannot be shown. */
  download: string;
  loadThree?: ThreeLoader | undefined;
  /**
   * Called, in place of the viewer's own message, when the view cannot be
   * shown, with what was thrown: a MeshLoadError for a mesh that could not
   * be fetched or read, anything else for a viewer that cannot start.
   */
  onFailed?: ((error: unknown) => void) | undefined;
  /** The caller's buttons, between the view and its controls. */
  actions?: ReactNode;
}

export function Viewer3d({ source, label, download, loadThree, onFailed, actions }: Viewer3dProps) {
  const { t, rich } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<ViewerHandle | null>(null);
  const [failed, setFailed] = useState(false);
  // The latest onFailed, read when a load fails, so a new callback from the
  // caller never starts the load again.
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const kind = source?.kind;
  const url = source?.url;

  useEffect(() => {
    let cancelled = false;
    let shown: ViewerHandle | undefined;
    const controller = new AbortController();
    setHandle(null);
    setFailed(false);
    if (kind === undefined || url === undefined) return;
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
      } catch (error) {
        if (cancelled) return;
        const handOver = failedRef.current;
        if (handOver === undefined) setFailed(true);
        else handOver(error);
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
          aria-label={t("viewer.label", { name: label })}
        />
        {failed ? (
          <p className="studio-placeholder">
            <span>
              {rich(
                "viewer.failed",
                { name: label },
                { a: (children) => <a href={download}>{children}</a> },
              )}
            </span>
          </p>
        ) : handle === null ? (
          <p className="studio-placeholder">{t("viewer.loading")}</p>
        ) : null}
      </div>
      {actions}
      {failed ? null : (
        <fieldset className="studio-actions ph-viewer-controls">
          <legend className="studio-visually-hidden">{t("viewer.controls")}</legend>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.rotate(-ROTATE_STEP))}
          >
            {t("viewer.rotateLeft")}
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.rotate(ROTATE_STEP))}
          >
            {t("viewer.rotateRight")}
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.zoom(ZOOM_STEP))}
          >
            {t("viewer.zoomIn")}
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.zoom(1 / ZOOM_STEP))}
          >
            {t("viewer.zoomOut")}
          </button>
          <button
            type="button"
            className="studio-button"
            aria-disabled={handle === null}
            onClick={() => press((h) => h.reset())}
          >
            {t("viewer.reset")}
          </button>
        </fieldset>
      )}
    </>
  );
}
