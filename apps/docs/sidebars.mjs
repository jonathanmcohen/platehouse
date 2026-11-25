// The docs sidebar, in reading order. Each id is a file in the repository's
// docs/ folder, without its extension.

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    { type: "doc", id: "index", label: "Home" },
    "install",
    "configuration",
    "sign-in",
    "storage",
    {
      type: "category",
      label: "Reverse proxy",
      link: { type: "doc", id: "reverse-proxy/index" },
      items: [
        "reverse-proxy/nginx",
        "reverse-proxy/caddy",
        "reverse-proxy/traefik",
        "reverse-proxy/apache",
        "reverse-proxy/checklist",
      ],
    },
    "security",
    "backups-and-upgrades",
    {
      type: "category",
      label: "Using Platehouse",
      link: { type: "doc", id: "using/index" },
      items: [
        "using/adding-files",
        "using/importing-from-manyfold",
        "using/models-files-plates",
        "using/printers-and-estimates",
        "using/open-in-slicer",
        "using/organising",
        "using/trash",
        "using/activity",
        "using/settings",
        "using/new-in-0-1-1",
        "using/new-in-0-1-0",
      ],
    },
    "api",
    "troubleshooting",
    // Mostly for contributors, so near the end.
    {
      type: "category",
      label: "Translations",
      link: { type: "doc", id: "translations/index" },
      items: ["translations/contributing", "translations/locales-dir"],
    },
    "changelog",
  ],
};

export default sidebars;
