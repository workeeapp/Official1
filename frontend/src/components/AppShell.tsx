import type { ReactNode } from "react";
import type { PublicUser } from "@workee/shared";
import { Header } from "./Header";
import { AppNav } from "./AppNav";

interface AppShellProps {
  user: PublicUser;
  onLogout: () => void;
  children: ReactNode;
}

export function AppShell({ user, onLogout, children }: AppShellProps) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <Header user={user} onLogout={onLogout} />
      <AppNav />
      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        {children}
      </main>
    </div>
  );
}
