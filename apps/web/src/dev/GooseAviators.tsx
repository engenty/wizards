const LEFT_LENS =
  "M18 9 C60 -4 132 -3 166 9 C178 27 170 77 151 106 C133 133 103 142 72 133 C37 125 16 99 10 63 C5 37 8 18 18 9 Z";
const RIGHT_LENS =
  "M192 11 C226 -1 281 0 305 11 C318 29 311 73 295 105 C281 132 258 142 228 135 C201 128 188 101 184 65 C181 37 185 19 192 11 Z";

export function GooseAviators({ coat }: { coat: "fur" | "jelly" }) {
  const leftGlass = `${coat}-goose-left-glass`;
  const rightGlass = `${coat}-goose-right-glass`;
  const frame = `${coat}-goose-frame`;
  const shadow = `${coat}-goose-glasses-shadow`;

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid meet"
      viewBox="0 0 1354 1161"
    >
      <defs>
        <linearGradient id={leftGlass} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#111d20" stopOpacity="0.56" />
          <stop offset="0.48" stopColor="#172b2e" stopOpacity="0.37" />
          <stop offset="1" stopColor="#10191b" stopOpacity="0.63" />
        </linearGradient>
        <linearGradient id={rightGlass} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#192324" />
          <stop offset="0.6" stopColor="#101b1c" />
          <stop offset="1" stopColor="#080e10" />
        </linearGradient>
        <linearGradient id={frame} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#f4e0ae" />
          <stop offset="0.45" stopColor="#9b7540" />
          <stop offset="1" stopColor="#e7c990" />
        </linearGradient>
        <filter id={shadow} height="140%" width="140%" x="-20%" y="-20%">
          <feDropShadow dx="1" dy="5" floodColor="#101015" floodOpacity="0.46" stdDeviation="4" />
        </filter>
      </defs>
      {(
        [
          { key: "helmet", x: 945, y: 247 },
          { key: "off-duty", x: 284, y: 767 },
        ] as const
      ).map(({ key, x, y }) => (
        <g filter={`url(#${shadow})`} key={key} transform={`translate(${x} ${y})`}>
          <path
            d="M9 32 C-13 32 -34 36 -56 43"
            fill="none"
            stroke="#31291f"
            strokeLinecap="round"
            strokeWidth="7"
          />
          <path
            d="M9 32 C-13 32 -34 36 -56 43"
            fill="none"
            stroke={`url(#${frame})`}
            strokeLinecap="round"
            strokeWidth="3"
          />
          <path d={LEFT_LENS} fill={`url(#${leftGlass})`} stroke="#32291b" strokeWidth="7" />
          <path d={RIGHT_LENS} fill={`url(#${rightGlass})`} stroke="#32291b" strokeWidth="7" />
          <path d={LEFT_LENS} fill="none" stroke={`url(#${frame})`} strokeWidth="3" />
          <path d={RIGHT_LENS} fill="none" stroke={`url(#${frame})`} strokeWidth="3" />
          <path
            d="M169 21 C174 15 184 15 190 22 M168 29 C175 23 183 23 187 29"
            fill="none"
            stroke={`url(#${frame})`}
            strokeLinecap="round"
            strokeWidth="3"
          />
          <path
            d="M23 16 C67 5 130 5 159 13 M193 17 C225 7 270 7 299 17"
            fill="none"
            opacity="0.38"
            stroke="#fff7dd"
            strokeLinecap="round"
            strokeWidth="2"
          />
          <path
            d="M311 31 C319 31 323 32 327 34"
            fill="none"
            stroke={`url(#${frame})`}
            strokeLinecap="round"
            strokeWidth="5"
          />
        </g>
      ))}
    </svg>
  );
}
