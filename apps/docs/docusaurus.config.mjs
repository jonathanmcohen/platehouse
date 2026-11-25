// The Platehouse user docs. The pages themselves live in the repository's
// docs/ folder, so there is one copy of each; this package only builds them.
//
// Privacy: nothing on a built page loads from another site. No analytics, no
// Algolia, no external fonts (the classic theme uses the system font stack)
// and no external scripts or stylesheets. Search is a local index built at
// build time by @easyops-cn/docusaurus-search-local. The social card and the
// icons below are files of this site, so they load from the same place.
//
// Edit links were off while the repository's address could still change.
// It is settled now (https://github.com/jonathanmcohen/platehouse), so each
// page has an "Edit this page" link to its file under docs/ on main, and
// the navbar and footer link to the repository, its releases and its
// issues. These are plain links: nothing loads from GitHub until a reader
// follows one.
//
// Where the site is published: .github/workflows/docs-pages.yml builds it
// for GitHub Pages and passes the address actions/configure-pages reports in
// two environment variables, so the site's own address is never written
// here:
//
//   DOCS_SITE_URL   the site's origin, such as https://owner.github.io
//   DOCS_BASE_PATH  the path the site lives under, such as /repo, or empty
//                   for a site at the root of its origin
//
// A local or pull-request build sets neither and gets the placeholder
// address at the root. A variable that is set must be usable: an empty or
// malformed DOCS_SITE_URL, or a malformed DOCS_BASE_PATH, fails the build
// rather than publish a site whose links point at the placeholder. An empty
// DOCS_BASE_PATH means the site root, and must: configure-pages gives an
// empty base path for a user site or a custom domain.
import { themes } from "prism-react-renderer";

const PLACEHOLDER_URL = "https://platehouse.example.com";

/** The source repository, for the edit links and the GitHub links. */
const REPO_URL = "https://github.com/jonathanmcohen/platehouse";

/** The site's origin, from DOCS_SITE_URL when it is set. */
function siteUrl(value) {
  if (value === undefined) return PLACEHOLDER_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`DOCS_SITE_URL is not a URL: "${value}"`);
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      `DOCS_SITE_URL must be an origin with no path, such as https://owner.github.io: "${value}"`,
    );
  }
  return parsed.origin;
}

/** The base URL Docusaurus wants, with a slash at each end, from DOCS_BASE_PATH. */
function baseUrl(value) {
  if (value === undefined) return "/";
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "/";
  const segments = trimmed.split("/");
  if (!segments.every((s) => /^[A-Za-z0-9._~-]+$/.test(s) && s !== "." && s !== "..")) {
    throw new Error(`DOCS_BASE_PATH must be a plain path such as /repo, or empty: "${value}"`);
  }
  return `/${trimmed}/`;
}

const url = siteUrl(process.env.DOCS_SITE_URL);
const base = baseUrl(process.env.DOCS_BASE_PATH);

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Platehouse",
  tagline: "A self-hosted library for 3D print files",
  url,
  baseUrl: base,
  trailingSlash: false,
  // Every icon and image the site shows is Platehouse's own, drawn from the
  // one logo art by tools/brand, and served from where that tool writes it,
  // so there is one copy of each: the navbar logo and the SVG favicon from
  // docs/assets (PR #236), and the PNG and ICO fallbacks, the Apple touch
  // icon and the social card from the web app's apps/web/public. The two
  // folders share favicon.svg, which tools/brand writes identically to both.
  // That folder also holds the web app's manifest and its other app icons;
  // they are copied into the build but nothing on a docs page links them.
  staticDirectories: ["../../docs/assets", "../../apps/web/public"],
  favicon: "favicon.svg",
  // The same icon links the web app's index.html carries, less the manifest.
  // Docusaurus does not add the base URL to a head tag, so it is added here.
  headTags: [
    { tagName: "link", attributes: { rel: "icon", href: `${base}favicon.ico`, sizes: "32x32" } },
    {
      tagName: "link",
      attributes: { rel: "apple-touch-icon", href: `${base}apple-touch-icon.png` },
    },
  ],
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
          // docPath is the page's path inside docs/, so the link opens that
          // file on main. A string here would be joined with the docs
          // folder's path from this site, ../../docs, which is not a path in
          // the repository.
          editUrl: ({ docPath }) => `${REPO_URL}/edit/main/docs/${docPath}`,
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
      // The social card: the app icon, square, so the card is the small
      // "summary" kind rather than the wide one Docusaurus asks for by default.
      image: "icon-512.png",
      metadata: [
        { name: "twitter:card", content: "summary" },
        // The accent, as in the web app's manifest.
        { name: "theme-color", content: "#5560e0" },
      ],
      colorMode: {
        defaultMode: "light",
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: "Platehouse",
        logo: { alt: "Platehouse logo", src: "logo.svg" },
        items: [
          { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
          { href: REPO_URL, label: "GitHub", position: "right" },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Platehouse",
            items: [
              { label: "Source on GitHub", href: REPO_URL },
              { label: "Releases", href: `${REPO_URL}/releases` },
              { label: "Issues", href: `${REPO_URL}/issues` },
            ],
          },
        ],
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
