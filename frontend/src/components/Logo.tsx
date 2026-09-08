interface LogoProps {
  compact?: boolean;
}

export function Logo({ compact = false }: LogoProps) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-white shadow-sm"
      >
        W
      </span>
      <span
        className={`text-lg font-semibold tracking-tight text-text-primary ${compact ? "sr-only sm:not-sr-only" : ""}`}
      >
        Workee
      </span>
    </div>
  );
}
