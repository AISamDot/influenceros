import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconTalking = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    <path d="M18.5 4.5c1 .9 1.5 2 1.5 3.5s-.5 2.6-1.5 3.5" />
  </Svg>
);
export const IconActivity = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M10 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
    <path d="M7 17h10" />
  </Svg>
);
export const IconVoiceover = (p: P) => (
  <Svg {...p}>
    <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
  </Svg>
);
export const IconStatic = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="9.5" r="1.6" />
    <path d="m4 18 5.5-5 4 3.5L17 13l3.5 3" />
  </Svg>
);
export const IconCarousel = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="5" width="12" height="14" rx="2.5" />
    <path d="M3 7v10M21 7v10" />
  </Svg>
);
export const IconBell = (p: P) => (
  <Svg {...p}>
    <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5" />
  </Svg>
);
export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M4 12 20 4l-6 16-3-7z" />
  </Svg>
);
export const IconFlag = (p: P) => (
  <Svg {...p}>
    <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
  </Svg>
);
export const IconArrow = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12 5 5L20 7" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M9 5v14M15 5v14" />
  </Svg>
);
export const IconPlug = (p: P) => (
  <Svg {...p}>
    <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
  </Svg>
);

const PLATFORM_GLYPH: Record<string, string> = { tiktok: 'TT', instagram: 'IG', youtube: 'YT', pinterest: 'PI' };
export function PlatformMark({ platform }: { platform: string }) {
  return (
    <span className="inline-grid h-[18px] min-w-[22px] place-items-center rounded-[5px] bg-surface-3 px-1 text-[9.5px] font-bold tracking-wide text-muted">
      {PLATFORM_GLYPH[platform] ?? platform.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function FormatIcon({ format, size = 14, ...rest }: { format: string } & P) {
  const C =
    format === 'talking'
      ? IconTalking
      : format === 'activity_text'
        ? IconActivity
        : format === 'voiceover'
          ? IconVoiceover
          : format === 'carousel'
            ? IconCarousel
            : IconStatic;
  return <C size={size} {...rest} />;
}
