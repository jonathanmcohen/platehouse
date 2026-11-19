// The Platehouse user docs. The pages themselves live in the repository's
// docs/ folder, so there is one copy of each; this package only builds them.
//
// Privacy: nothing on a built page loads from another site. No analytics, no
// Algolia, no external fonts (the classic theme uses the system font stack)
// and no external scripts or stylesheets. Search is a local index built at
// build time by @easyops-cn/docusaurus-search-local. Edit links are off,
// because the repository's address will change.
import { themes } from "prism-react-renderer";

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Platehouse",
  tagline: "A self-hosted library for 3D print files",
  // Placeholder until publishing is decided. Nothing is deployed from here.
  url: "https://platehouse.example.com",
  baseUrl: "/",
  trailingSlash: false,
  // The logo and favicon are the app's own, in docs/assets (PR #236), served
  // from there so there is one copy of each.
  staticDirectories: ["../../docs/assets"],
  favicon: "favicon.svg",
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  onDuplicateRoutes: "throw",
  markdown: {
    format: "detect",
    hooks: {
      onBrokenMarkdownLinks: "throw",
      onBrokenMarkdownImages: "throw",
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: "../../docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.mjs",
          showLastUpdateAuthor: false,
          showLastUpdateTime: false,
        },
        blog: false,
        pages: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      }),
    ],
  ],
  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: "/",
        docsDir: "../../docs",
        language: ["en"],
        highlightSearchTermsOnTargetPage: false,
      },
    ],
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: "light",
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: "Platehouse",
        logo: { alt: "Platehouse logo", src: "logo.svg" },
        items: [{ type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" }],
      },
      footer: {
        style: "dark",
        copyright: "Platehouse documentation.",
      },
      prism: {
        theme: themes.github,
        darkTheme: themes.dracula,
        additionalLanguages: ["bash", "nginx", "apacheconf", "yaml", "ini"],
      },
    }),
};

export default config;
