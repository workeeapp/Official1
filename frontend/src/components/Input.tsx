import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export function Input({
  id,
  label,
  error,
  name,
  className = "",
  ...props
}: InputProps) {
  const inputId = id ?? name;
  const errorId = inputId ? `${inputId}-error` : undefined;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className="text-sm font-medium text-text-primary"
      >
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={`min-h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-text-primary shadow-sm transition-colors placeholder:text-text-secondary/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 ${
          error ? "border-error" : "border-border"
        } ${className}`}
        {...props}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
