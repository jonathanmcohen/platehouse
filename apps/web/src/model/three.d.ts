// three.js ships no TypeScript types of its own, and the plan's Tech Stack
// names no @types/three, so its modules are declared here as untyped. Only
// Viewer3d.tsx's defaultLoadThree imports them, and it keeps the three.js
// code to one small function behind the typed ThreeViewer interface.
declare module "three";
declare module "three/addons/loaders/STLLoader.js";
declare module "three/addons/loaders/GLTFLoader.js";
declare module "three/addons/controls/OrbitControls.js";
