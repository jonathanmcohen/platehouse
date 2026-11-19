// The Platehouse logo in the app (icon A, logoArt.ts). It draws in
// currentColor, and its colour is var(--accent), so it follows whichever
// colour scheme and theme are in use with no colour of its own. Beside the
// "Platehouse" name (the sidebar's brand) it is aria-hidden, since the text
// already names it; given a label, it is an image with that name.
import { FULL_ART, LOGO_VIEWBOX, type LogoArt, SMALL_ART } from "./logoArt";

export interface LogoProps {
  /** Width and height in px. */
  size?: number;
  /** The two-layer art, for 16 px. */
  small?: boolean;
  /** The accessible name; without one the logo is hidden from assistive tech. */
  label?: string;
}

const VIEWBOX = `0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`;
const ACCENT_STYLE = { color: "var(--accent)" };

function Art({ art }: { art: LogoArt }) {
  return (
    <>
      <path
        d={art.roof.d}
        fill="none"
        stroke="currentColor"
        strokeWidth={art.roof.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {art.layers.map((layer) => (
        <rect
          key={layer.y}
          x={layer.x}
          y={layer.y}
          width={layer.width}
          height={layer.height}
          rx={layer.rx}
          fill="currentColor"
          {...(layer.opacity === 1 ? {} : { opacity: layer.opacity })}
        />
      ))}
    </>
  );
}

export function Logo({ size = 20, small = false, label }: LogoProps) {
  const art = small ? SMALL_ART : FULL_ART;
  if (label === undefined) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={VIEWBOX}
        width={size}
        height={size}
        style={ACCENT_STYLE}
        aria-hidden="true"
        focusable="false"
      >
        <Art art={art} />
      </svg>
    );
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={VIEWBOX}
      width={size}
      height={size}
      style={ACCENT_STYLE}
      role="img"
      aria-label={label}
      focusable="false"
    >
      <Art art={art} />
    </svg>
  );
}
