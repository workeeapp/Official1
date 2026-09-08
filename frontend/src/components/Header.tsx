import type { PublicUser } from "@workee/shared";
import { Logo } from "./Logo";
import { Button } from "./Button";

interface HeaderProps {
  user: PublicUser;
  onLogout: () => void;
}

export function Header({ user, onLogout }: HeaderProps) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex min-h-16 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Logo compact />
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary"
            >
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden max-w-40 truncate text-sm font-medium text-text-primary sm:inline">
              {user.username}
            </span>
          </div>
          <Button variant="ghost" onClick={onLogout} className="px-3">
            Log out
          </Button>
        </div>
      </div>
    </header>
  );
}
