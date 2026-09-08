import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
  loading?: boolean;
  busyLabel?: string;
}

export function Button({
  variant = "primary",
  loading = false,
  busyLabel = "Saving…",
  className = "",
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex min-h-11 w-full items-center justify-center rounded-xl px-4 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60";
  const variants = {
    primary:
      "bg-primary text-white shadow-sm hover:bg-primary-dark focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
    ghost:
      "w-auto min-w-11 bg-transparent text-text-secondary hover:bg-primary-light hover:text-primary",
    danger:
      "bg-error text-white shadow-sm hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-error focus-visible:ring-offset-2",
  };

  return (
    <button
      type={type}
      className={`${base} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading ? busyLabel : children}
    </button>
  );
}
