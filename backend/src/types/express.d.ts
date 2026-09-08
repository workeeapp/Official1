import type { PublicUser } from "@workee/shared";

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
      sessionId?: string;
    }
  }
}

export {};
