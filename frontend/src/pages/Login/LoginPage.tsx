import { FormEvent, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { hasFieldErrors, validateLoginInput, type FieldErrors } from "@workee/shared";
import { useAuth } from "@/hooks/useAuth";
import { ApiError } from "@/types";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { Logo } from "@/components/Logo";

export function LoginPage() {
  const { user, status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState({ username: false, password: false });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fieldErrors = useMemo(
    () => validateLoginInput({ username, password }),
    [username, password],
  );

  const visibleErrors: FieldErrors = {
    username: touched.username ? fieldErrors.username : undefined,
    password: touched.password ? fieldErrors.password : undefined,
  };

  if (status === "ready" && user) {
    return <Navigate to="/dashboard" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched({ username: true, password: true });
    setFormError(null);

    if (hasFieldErrors(fieldErrors)) {
      return;
    }

    setSubmitting(true);

    try {
      await login(username.trim(), password);
      const from = (location.state as { from?: { pathname?: string } } | null)
        ?.from?.pathname;
      navigate(from && from !== "/login" ? from : "/dashboard", { replace: true });
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="login-page"
      className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 sm:px-6"
    >
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo />
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-text-primary">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Sign in to your account
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          noValidate
          data-testid="login-card"
          className="w-full rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
        >
          <div className="flex flex-col gap-4">
            <Input
              name="username"
              label="Username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              error={visibleErrors.username}
              onBlur={() => setTouched((current) => ({ ...current, username: true }))}
              onChange={(event) => {
                setUsername(event.target.value);
                if (formError) {
                  setFormError(null);
                }
              }}
            />
            <Input
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              error={visibleErrors.password}
              onBlur={() => setTouched((current) => ({ ...current, password: true }))}
              onChange={(event) => {
                setPassword(event.target.value);
                if (formError) {
                  setFormError(null);
                }
              }}
            />
            <Button type="submit" loading={submitting} busyLabel="Signing in…">
              Login
            </Button>
          </div>

          {formError ? (
            <p
              role="alert"
              data-testid="login-error"
              className="mt-4 text-center text-sm text-error"
            >
              {formError}
            </p>
          ) : null}
        </form>
      </div>
    </div>
  );
}
