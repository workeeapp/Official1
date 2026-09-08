import type { AuthUserResponse, PublicUser } from "@workee/shared";
import { api } from "./http";

export const authApi = {
  login(username: string, password: string): Promise<AuthUserResponse> {
    return api<AuthUserResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  me(): Promise<AuthUserResponse> {
    return api<AuthUserResponse>("/api/auth/me");
  },

  logout(): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>("/api/auth/logout", {
      method: "POST",
    });
  },
};

export type { PublicUser };
