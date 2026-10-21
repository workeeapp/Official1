import type {
  PublicTip,
  TipInput,
  TipsResponse,
  TipUpdateInput,
} from "@workee/shared";
import { api } from "./http";

export const tipsApi = {
  list(signal?: AbortSignal): Promise<TipsResponse> {
    return api<TipsResponse>("/api/tips", { signal });
  },

  create(input: TipInput): Promise<{ tip: PublicTip }> {
    return api<{ tip: PublicTip }>("/api/tips", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  update(id: string, input: TipUpdateInput): Promise<{ tip: PublicTip }> {
    return api<{ tip: PublicTip }>(`/api/tips/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  remove(id: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/tips/${id}`, {
      method: "DELETE",
    });
  },

  send(id: string): Promise<{ ok: boolean }> {
    return api<{ ok: boolean }>(`/api/tips/${id}/send`, {
      method: "POST",
    });
  },
};
