const QUARTER_TURNS = [0, 90, 180, 270] as const;
const ACCENT_FILL = 'var(--subagent-icon-accent)';

// Keep these palettes in a fixed order: identity alone determines both color choices.
const SUBAGENT_COLORS = [
  {
    name: 'blue',
    color: 'text-blue-500 dark:text-blue-400',
    accent: '[--subagent-icon-accent:#93c5fd] dark:[--subagent-icon-accent:#bfdbfe]',
  },
  {
    name: 'teal',
    color: 'text-teal-600 dark:text-teal-400',
    accent: '[--subagent-icon-accent:#5eead4] dark:[--subagent-icon-accent:#99f6e4]',
  },
  {
    name: 'rose',
    color: 'text-rose-500 dark:text-rose-400',
    accent: '[--subagent-icon-accent:#fda4af] dark:[--subagent-icon-accent:#fecdd3]',
  },
  {
    name: 'pink',
    color: 'text-pink-500 dark:text-pink-400',
    accent: '[--subagent-icon-accent:#f9a8d4] dark:[--subagent-icon-accent:#fbcfe8]',
  },
  {
    name: 'yellow',
    color: 'text-yellow-600 dark:text-yellow-400',
    accent: '[--subagent-icon-accent:#fde047] dark:[--subagent-icon-accent:#fef08a]',
  },
  {
    name: 'violet',
    color: 'text-violet-500 dark:text-violet-400',
    accent: '[--subagent-icon-accent:#c4b5fd] dark:[--subagent-icon-accent:#ddd6fe]',
  },
  {
    name: 'cyan',
    color: 'text-cyan-600 dark:text-cyan-400',
    accent: '[--subagent-icon-accent:#67e8f9] dark:[--subagent-icon-accent:#a5f3fc]',
  },
  {
    name: 'emerald',
    color: 'text-emerald-600 dark:text-emerald-400',
    accent: '[--subagent-icon-accent:#6ee7b7] dark:[--subagent-icon-accent:#a7f3d0]',
  },
  {
    name: 'orange',
    color: 'text-orange-500 dark:text-orange-400',
    accent: '[--subagent-icon-accent:#fdba74] dark:[--subagent-icon-accent:#fed7aa]',
  },
  {
    name: 'indigo',
    color: 'text-indigo-500 dark:text-indigo-400',
    accent: '[--subagent-icon-accent:#a5b4fc] dark:[--subagent-icon-accent:#c7d2fe]',
  },
  {
    name: 'fuchsia',
    color: 'text-fuchsia-600 dark:text-fuchsia-400',
    accent: '[--subagent-icon-accent:#f0abfc] dark:[--subagent-icon-accent:#f5d0fe]',
  },
  {
    name: 'lime',
    color: 'text-lime-600 dark:text-lime-400',
    accent: '[--subagent-icon-accent:#bef264] dark:[--subagent-icon-accent:#d9f99d]',
  },
  {
    name: 'sky',
    color: 'text-sky-600 dark:text-sky-400',
    accent: '[--subagent-icon-accent:#7dd3fc] dark:[--subagent-icon-accent:#bae6fd]',
  },
  {
    name: 'red',
    color: 'text-red-500 dark:text-red-400',
    accent: '[--subagent-icon-accent:#fca5a5] dark:[--subagent-icon-accent:#fecaca]',
  },
  {
    name: 'amber',
    color: 'text-amber-600 dark:text-amber-400',
    accent: '[--subagent-icon-accent:#fcd34d] dark:[--subagent-icon-accent:#fde68a]',
  },
  {
    name: 'purple',
    color: 'text-purple-500 dark:text-purple-400',
    accent: '[--subagent-icon-accent:#d8b4fe] dark:[--subagent-icon-accent:#e9d5ff]',
  },
] as const;

const SUBAGENT_ICONS = [
  {
    name: 'pinwheel',
    artwork: (
      <>
        {QUARTER_TURNS.map(angle => (
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <path d="M12 12C8.5 12 6 9.7 6 6.8 6 3.7 8.5 2 11.4 2c2.6 0 4.7 1.3 5.6 3.5C13.8 5.2 12 7.8 12 12Z" />
            <path
              d="M7.2 4.1C9.5 2.3 13.6 2.6 15.5 4.3 11.7 4.8 10.4 7.5 10.8 11.8 8.2 11.2 6.7 9.3 6.7 7c0-1.1.2-2.1.5-2.9Z"
              fill={ACCENT_FILL}
              fillOpacity="0.85"
            />
          </g>
        ))}
      </>
    ),
  },
  {
    name: 'aperture',
    artwork: (
      <>
        <circle cx="12" cy="12" r="10" opacity="0.35" />
        {QUARTER_TURNS.map(angle => (
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <path d="M12 2a10 10 0 0 1 9.7 7.5H12Z" />
            <path d="M12 3.5a8.5 8.5 0 0 1 7.7 5H12Z" fill={ACCENT_FILL} />
          </g>
        ))}
        <path d="m9.5 9.5 5 0 0 5-5 0Z" fill={ACCENT_FILL} fillOpacity="0.7" />
      </>
    ),
  },
  {
    name: 'rosette',
    artwork: (
      <>
        {QUARTER_TURNS.map(angle => (
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <circle cx="6.8" cy="6.8" r="4.8" />
            <circle cx="6.8" cy="6.8" r="3.2" fill={ACCENT_FILL} />
            <path
              d="M5.2 7.8c-1.6-2.2 1.4-4.3 3-2.5 1.2 1.3-.6 3.2-1.7 2.1"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
            />
          </g>
        ))}
      </>
    ),
  },
  {
    name: 'flower',
    artwork: (
      <>
        {[0, 60, 120, 180, 240, 300].map(angle => (
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <ellipse cx="12" cy="7.2" rx="3.1" ry="5.2" fillOpacity="0.8" />
            <ellipse cx="11.5" cy="6.4" rx="1.3" ry="3.2" fill={ACCENT_FILL} fillOpacity="0.85" />
          </g>
        ))}
        <circle cx="12" cy="12" r="2.4" fill={ACCENT_FILL} />
      </>
    ),
  },
  {
    name: 'sunburst',
    artwork: (
      <>
        {[0, 40, 80, 120, 160, 200, 240, 280, 320].map((angle, index) => (
          <g
            key={angle}
            transform={`rotate(${angle} 12 12)`}
            fill={index % 2 ? ACCENT_FILL : undefined}
          >
            <rect x="10.5" y="1.5" width="3" height="10.5" rx="1.5" />
            <path d="M11.2 3v6" stroke="white" strokeOpacity="0.25" strokeLinecap="round" />
          </g>
        ))}
        <circle cx="12" cy="12" r="3" />
        <circle cx="11.5" cy="11.5" r="1.6" fill="white" fillOpacity="0.2" />
      </>
    ),
  },
  {
    name: 'compass',
    artwork: (
      <>
        <path d="M12 1 23 12 12 23 1 12Z" fillOpacity="0.5" />
        <path d="M12 1v22M1 12h22M5.2 5.2l13.6 13.6M18.8 5.2 5.2 18.8" stroke="currentColor" />
        <path d="m12 2 2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2Z" />
        <path d="M12 2v10H2l7.8-2.2Zm0 10h10l-7.8 2.2L12 22Z" fill={ACCENT_FILL} />
        <path d="M12 3v18M3 12h18" stroke="white" strokeOpacity="0.6" strokeWidth="1.2" />
      </>
    ),
  },
  {
    name: 'orbit',
    artwork: (
      <>
        <circle cx="12" cy="12" r="4" />
        <ellipse
          cx="12"
          cy="12"
          rx="10"
          ry="5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          transform="rotate(-35 12 12)"
        />
        <circle cx="19.5" cy="6.5" r="3" fill={ACCENT_FILL} />
        <circle cx="4.5" cy="17.5" r="2" />
      </>
    ),
  },
  {
    name: 'cube',
    artwork: (
      <>
        <path d="m12 1 10 5.5v11L12 23 2 17.5v-11Z" />
        <path d="m12 1 10 5.5L12 12 2 6.5Z" fill={ACCENT_FILL} />
        <path d="M12 12v11l10-5.5v-11Z" fill="black" fillOpacity="0.16" />
        <path d="m2 6.5 10 5.5 10-5.5M12 12v11" fill="none" stroke="white" strokeOpacity="0.35" />
      </>
    ),
  },
  {
    name: 'prism',
    artwork: (
      <>
        <path d="m12 1 10.5 20H1.5Z" />
        <path d="m12 1 3.5 13L1.5 21Z" fill={ACCENT_FILL} />
        <path d="m15.5 14 7 7h-21Z" fill="black" fillOpacity="0.15" />
        <path d="m12 1 3.5 13-14 7M15.5 14l7 7" fill="none" stroke="white" strokeOpacity="0.35" />
      </>
    ),
  },
  {
    name: 'honeycomb',
    artwork: (
      <>
        <path d="m7 1 5 3v6l-5 3-5-3V4Zm10 0 5 3v6l-5 3-5-3V4Z" />
        <path d="m12 11 5 3v6l-5 3-5-3v-6Z" fill={ACCENT_FILL} />
        <path
          d="m7 4 2.5 1.5v3L7 10 4.5 8.5v-3Zm10 0 2.5 1.5v3L17 10l-2.5-1.5v-3Z"
          fill="white"
          fillOpacity="0.3"
        />
      </>
    ),
  },
  {
    name: 'bowtie',
    artwork: (
      <>
        <path d="M2 3q0-2 2-1l8 7 8-7q2-1 2 1v18q0 2-2 1l-8-7-8 7q-2 1-2-1Z" />
        <path d="m2 3 10 9L2 21Zm20 0L12 12l10 9Z" fill={ACCENT_FILL} fillOpacity="0.9" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  },
  {
    name: 'linked-rings',
    artwork: (
      <g fill="none" strokeWidth="3.5">
        <ellipse
          cx="8.5"
          cy="10"
          rx="5.5"
          ry="8"
          transform="rotate(-30 8.5 10)"
          stroke="currentColor"
        />
        <ellipse
          cx="15.5"
          cy="14"
          rx="5.5"
          ry="8"
          transform="rotate(-30 15.5 14)"
          stroke={ACCENT_FILL}
        />
        <path d="M3 6a5.5 8 0 0 1 8-2" stroke="currentColor" />
      </g>
    ),
  },
  {
    name: 'spiral',
    artwork: (
      <>
        <path
          d="M21 12a9 9 0 1 1-9-9c4 0 7 2.7 7 6.5s-2.4 6.5-6 6.5a4 4 0 0 1-4-4c0-2 1.3-3 3-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <path
          d="M12 3c4 0 7 2.7 7 6.5s-2.4 6.5-6 6.5"
          fill="none"
          stroke={ACCENT_FILL}
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle cx="12" cy="11" r="2" />
      </>
    ),
  },
  {
    name: 'waves',
    artwork: (
      <g fill="none" strokeWidth="3.2" strokeLinecap="round">
        <path d="M2 6q5-6 10 0t10 0M2 18q5-6 10 0t10 0" stroke="currentColor" />
        <path d="M2 12q5-6 10 0t10 0" stroke={ACCENT_FILL} />
      </g>
    ),
  },
  {
    name: 'fan',
    artwork: (
      <>
        <path d="M12 22 1 8l4-4 7 2 7-2 4 4Z" />
        <path d="M12 22 5 4l7-3 7 3Z" fill={ACCENT_FILL} />
        <path d="M12 3v17M3 8l9 12 9-12" fill="none" stroke="white" strokeOpacity="0.35" />
        <circle cx="12" cy="20" r="2.5" />
      </>
    ),
  },
  {
    name: 'mosaic',
    artwork: (
      <>
        <rect x="2" y="2" width="9" height="9" rx="2.5" />
        <rect x="13" y="13" width="9" height="9" rx="2.5" />
        <path
          d="m17.5 1 5.5 5.5-5.5 5.5L12 6.5ZM6.5 12l5.5 5.5L6.5 23 1 17.5Z"
          fill={ACCENT_FILL}
        />
      </>
    ),
  },
  {
    name: 'ripple',
    artwork: (
      <>
        <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <circle cx="12" cy="12" r="5.5" fill="none" stroke={ACCENT_FILL} strokeWidth="2.5" />
        <circle cx="12" cy="12" r="2.5" />
      </>
    ),
  },
  {
    name: 'comet',
    artwork: (
      <>
        <path d="m2 2 18 6 2 5-9 9-5-2Z" fillOpacity="0.55" />
        <path d="m2 2 16 8-8 8Zm8 0 12 6-3 3Z" fill={ACCENT_FILL} />
        <circle cx="16" cy="16" r="6" />
        <circle cx="17" cy="14.5" r="2.5" fill={ACCENT_FILL} />
      </>
    ),
  },
  {
    name: 'butterfly',
    artwork: (
      <>
        <path d="M12 12C-1-7-2 16 10 14-1 26 14 24 12 12Zm0 0C25-7 26 16 14 14c11 12-4 10-2-2Z" />
        <path d="M10 11C3-1 1 11 10 11Zm4 0c7-12 9 0 0 0Z" fill={ACCENT_FILL} />
        <path d="M12 8v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },
  {
    name: 'crown',
    artwork: (
      <>
        <path d="m2 5 6 5 4-8 4 8 6-5-3 15H5Z" />
        <path d="m8 10 4-8 4 8-4 6Z" fill={ACCENT_FILL} />
        <rect x="5" y="19" width="14" height="3" rx="1.5" fill={ACCENT_FILL} />
        <circle cx="2" cy="5" r="1.5" />
        <circle cx="22" cy="5" r="1.5" />
      </>
    ),
  },
  {
    name: 'lotus',
    artwork: (
      <>
        <path d="M12 21C3 21 1 13 2 7c6 1 10 6 10 14Zm0 0c9 0 11-8 10-14-6 1-10 6-10 14Z" />
        <path d="M12 22C4 16 7 6 12 1c5 5 8 15 0 21Z" fill={ACCENT_FILL} />
        <path d="M12 8v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  {
    name: 'lightning',
    artwork: (
      <>
        <path d="M13 1 3 14h7l-1 9L22 9h-8l3-8Z" />
        <path d="m13 1-3 11h7L9 23l13-14h-8l3-8Z" fill={ACCENT_FILL} fillOpacity="0.9" />
      </>
    ),
  },
  {
    name: 'braid',
    artwork: (
      <g fill="none" strokeWidth="3.5" strokeLinecap="round">
        <path d="M7 2C22 9 2 15 17 22" stroke="currentColor" />
        <path d="M17 2C2 9 22 15 7 22" stroke={ACCENT_FILL} />
        <path d="m7 2 10 0M7 22h10" stroke="currentColor" strokeWidth="2" />
      </g>
    ),
  },
  {
    name: 'asterisk',
    artwork: (
      <>
        {[0, 60, 120].map(angle => (
          <rect
            key={angle}
            x="2"
            y="9.5"
            width="20"
            height="5"
            rx="2.5"
            transform={`rotate(${angle} 12 12)`}
          />
        ))}
        <path
          d="M3 12h18M7.5 4.2l9 15.6"
          stroke={ACCENT_FILL}
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="3" fill={ACCENT_FILL} />
      </>
    ),
  },
] as const;

// Avalanche before each choice so shared ID prefixes and power-of-two palette sizes
// cannot couple the motif and color indices through the low bits of a simple hash.
function mixHash(value: number): number {
  let hash = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** Derive appearance from native identity so status, ordering and labels cannot change it. */
export default function SubagentIcon({
  identity,
  className = 'h-5 w-5',
}: {
  identity: string;
  className?: string;
}) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193);
  }
  const icon = SUBAGENT_ICONS[mixHash(hash ^ 0x9e3779b9) % SUBAGENT_ICONS.length];
  const primaryIndex = mixHash(hash ^ 0x243f6a88) % SUBAGENT_COLORS.length;
  const primary = SUBAGENT_COLORS[primaryIndex];
  const accentOffset = 1 + (mixHash(hash ^ 0xb7e15162) % (SUBAGENT_COLORS.length - 1));
  const accent = SUBAGENT_COLORS[(primaryIndex + accentOffset) % SUBAGENT_COLORS.length];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={`shrink-0 ${primary.color} ${accent.accent} ${className}`}
      data-subagent-icon={icon.name}
      data-subagent-palette={`${primary.name}-${accent.name}`}
    >
      {icon.artwork}
    </svg>
  );
}
