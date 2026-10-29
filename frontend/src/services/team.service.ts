import type { PublicTeam } from "@workee/shared";
import { api } from "./http";

export const teamApi = {
  get(): Promise<{ team: PublicTeam }> {
    return api<{ team: PublicTeam }>("/api/team");
  },

  list(): Promise<{ teams: PublicTeam[] }> {
    return api<{ teams: PublicTeam[] }>("/api/team/list");
  },
};
