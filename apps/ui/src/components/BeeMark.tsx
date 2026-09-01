/**
 * The Hive mark: an angular, low-poly bee.
 *
 * Inline SVG rather than a raster asset — it stays sharp at any size, costs no
 * request, and takes its colours from the same honey/near-black palette as the
 * rest of the console, so it cannot drift out of theme. The wings are drawn as
 * honeycomb cells because that is the motif the whole product is built on.
 */
export function BeeMark({ className, size = 18 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Hive"
    >
      <defs>
        <linearGradient id="beeWing" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFC107" />
          <stop offset="100%" stopColor="#B45309" />
        </linearGradient>
        <linearGradient id="beeBand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FCD34D" />
          <stop offset="100%" stopColor="#F59E0B" />
        </linearGradient>
        {/* One cell, tiled across each wing. */}
        <pattern id="beeComb" width="13" height="11.3" patternUnits="userSpaceOnUse">
          <path
            d="M6.5 0 L13 3.75 L13 11.3 L6.5 15 L0 11.3 L0 3.75 Z"
            fill="none"
            stroke="#7C2D12"
            strokeOpacity="0.55"
            strokeWidth="1.6"
          />
        </pattern>
      </defs>

      {/* antennae */}
      <path
        d="M52 30 L44 15 M68 30 L76 15"
        stroke="#FCD34D"
        strokeWidth="6"
        strokeLinecap="round"
      />

      {/* wings */}
      <g>
        <path d="M46 44 L8 30 L2 52 L22 66 L46 60 Z" fill="url(#beeWing)" />
        <path d="M46 44 L8 30 L2 52 L22 66 L46 60 Z" fill="url(#beeComb)" />
        <path
          d="M46 44 L8 30 L2 52 L22 66 L46 60 Z"
          fill="none"
          stroke="#0A0A0A"
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <path d="M74 44 L112 30 L118 52 L98 66 L74 60 Z" fill="url(#beeWing)" />
        <path d="M74 44 L112 30 L118 52 L98 66 L74 60 Z" fill="url(#beeComb)" />
        <path
          d="M74 44 L112 30 L118 52 L98 66 L74 60 Z"
          fill="none"
          stroke="#0A0A0A"
          strokeWidth="4"
          strokeLinejoin="round"
        />
      </g>

      {/* head */}
      <path
        d="M60 24 L82 38 L78 54 L60 62 L42 54 L38 38 Z"
        fill="#141414"
        stroke="#0A0A0A"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      {/* eyes — the one place the mark looks back at you */}
      <path d="M45 40 L57 46 L52 52 L43 47 Z" fill="#FFC107" />
      <path d="M75 40 L63 46 L68 52 L77 47 Z" fill="#FFC107" />

      {/* abdomen: chevron bands, the shape the whole palette is built from */}
      <path
        d="M40 58 L60 58 L80 58 L74 108 L60 118 L46 108 Z"
        fill="#141414"
        stroke="#0A0A0A"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M41 66 L60 74 L79 66 L78 78 L60 86 L42 78 Z" fill="url(#beeBand)" />
      <path d="M44 88 L60 95 L76 88 L74 99 L60 106 L46 99 Z" fill="url(#beeBand)" />
    </svg>
  );
}
