import { Router } from "express";
import { sendMessage } from "../controllers/chat.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { chatRateLimiter } from "../middleware/rate-limit.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const chatRouter = Router();

chatRouter.post("/messages", requireAuth, chatRateLimiter, asyncHandler(sendMessage));
