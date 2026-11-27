import { join } from "node:path";

/** The environment Orca runs with: everything it writes stays in the job folder. */
export function scratchEnv(dir: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    XDG_CONFIG_HOME: join(dir, "home", ".config"),
    XDG_CACHE_HOME: join(dir, "home", ".cache"),
    XDG_DATA_HOME: join(dir, "home", ".local", "share"),
    XDG_RUNTIME_DIR: join(dir, "tmp"),
    MESA_SHADER_CACHE_DISABLE: "true",
    LANG: "C.UTF-8",
  };
}

/**
 * What OrcaSlicer 2.5.0's AppImage launcher sets before it runs
 * bin/orca-slicer, so the server can run that binary itself, in the sandbox,
 * without the launcher. Read from the scripts that build the AppImage, at the
 * commit the v2.5.0 tag points to (40ecc66, the Dockerfile's ORCA_SRC_SHA):
 * src/dev-utils/platform/unix/build_linux_image.sh.in writes both files.
 *
 * - AppRun, a bash script, sets APPDIR to its own folder and LC_ALL=C (a
 *   workaround for a crash on unexpected locales), and only on a Wayland
 *   desktop (XDG_SESSION_TYPE=wayland, never set here) runs glxinfo and
 *   nvidia-smi. Then it execs libexec/orca-slicer-env bin/orca-slicer.
 * - libexec/orca-slicer-env, a sh script, sets LD_LIBRARY_PATH to
 *   lib/orca-runtime:bin (the image has lib/orca-runtime; the Dockerfile
 *   checks it). It checks with ldd and ldconfig that the host has
 *   libOpenGL.so.0 and WebKitGTK 4.1, and exits if not; the image installs
 *   both (libopengl0, libwebkit2gtk-4.1-0), and its build checks that every
 *   library bin/orca-slicer links resolves with this library path
 *   (check-libs.sh), so a missing one fails the build instead. Only an
 *   AppImage that bundles its own WebKitGTK (lib/libwebkit2gtk-4.x.so.0)
 *   would set more (GStreamer, GIO and WebKit paths); the release AppImage
 *   is built without it (ORCA_BUNDLE_DESKTOP_STACK unset, and
 *   scripts/appimage_lib_policy.sh keeps WebKitGTK a host library), and the
 *   Dockerfile fails the build if such a library is there.
 *
 * So for this image the launcher's environment is fixed, and the server
 * runs bin/orca-slicer directly with it (the preferred choice), rather than
 * letting bash, sh, ldd, ldconfig and grep run inside Orca's sandbox. The
 * binary finds its resources from its own path (/proc/self/exe), as under
 * the launcher.
 */
export function launcherEnv(orcaDir: string): Record<string, string> {
  return {
    APPDIR: orcaDir,
    LC_ALL: "C",
    LD_LIBRARY_PATH: `${orcaDir}/lib/orca-runtime:${orcaDir}/bin`,
  };
}
