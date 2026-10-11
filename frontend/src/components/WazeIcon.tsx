export function WazeIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M16 3.5C9.1 3.5 4 8.4 4 14.6c0 2.6.9 4.7 2.4 6.3-.3 1.5-1.1 2.6-2.3 3.2 1.9.6 4.1.3 5.6-.8 1.9 1 4 1.6 6.3 1.6C22.9 24.9 28 20 28 14.2 28 8.4 22.9 3.5 16 3.5Z"
        fill="#33CCFF"
        stroke="#1A1A1A"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="1.4" fill="#1A1A1A" />
      <circle cx="20" cy="13" r="1.4" fill="#1A1A1A" />
      <path
        d="M11.5 17.2c1.1 1.5 2.7 2.3 4.5 2.3s3.4-.8 4.5-2.3"
        fill="none"
        stroke="#1A1A1A"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="10.5" cy="26.5" r="2.2" fill="#1A1A1A" />
      <circle cx="21" cy="26.5" r="2.2" fill="#1A1A1A" />
    </svg>
  );
}
