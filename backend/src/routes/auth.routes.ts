import { Router } from "express";
import { login, logout, me } from "../controllers/auth.controller.js";
import { optionalAuth, requireAuth } from "../middleware/auth.middleware.js";
import { loginRateLimiter } from "../middleware/rate-limit.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const authRouter = Router();

authRouter.post("/login", loginRateLimiter, asyncHandler(login));
authRouter.get("/me", requireAuth, asyncHandler(me));
authRouter.post("/logout", optionalAuth, asyncHandler(logout));
