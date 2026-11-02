const TRACK = "M112 360c72 0 100-60 148-116s92-76 140-76";

/** Løype mark: a groomed double ski track curving up a hill. Matches /icon.svg. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden className="shrink-0">
      <rect width="512" height="512" rx="120" fill="#141518" />
      <rect x="4" y="4" width="504" height="504" rx="116" fill="none" stroke="#fff" strokeOpacity="0.08" strokeWidth="8" />
      <path d={TRACK} fill="none" stroke="#ff6b3d" strokeWidth="60" strokeLinecap="butt" />
      <path d={TRACK} fill="none" stroke="#141518" strokeWidth="16" strokeLinecap="butt" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={className ?? "text-xl font-bold tracking-[-0.04em]"}>Løype</span>;
}
