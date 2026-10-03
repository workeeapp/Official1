interface LogoProps {
  compact?: boolean;
}

export function WorkeeMark({
  inverted = false,
  className = "h-4 w-4 rounded-md text-[9px]",
}: {
  inverted?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="workee-mark"
      className={`inline-flex shrink-0 items-center justify-center font-semibold ${
        inverted ? "bg-white text-primary" : "bg-primary text-white"
      } ${className}`}
    >
      W
    </span>
  );
}

export function Logo({ compact = false }: LogoProps) {
  return (
    <div className="flex items-center gap-2.5">
      <WorkeeMark className="h-9 w-9 rounded-xl text-sm shadow-sm" />
      <span
        className={`text-lg font-semibold tracking-tight text-text-primary ${compact ? "sr-only sm:not-sr-only" : ""}`}
      >
        Workee
      </span>
    </div>
  );
}
