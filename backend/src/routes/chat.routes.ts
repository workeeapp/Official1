import { Router } from "express";
import {
  listMessages,
  resetConversation,
  sendMessage,
  streamChatEvents,
} from "../controllers/chat.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { chatRateLimiter } from "../middleware/rate-limit.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const chatRouter = Router();

chatRouter.get("/messages", requireAuth, asyncHandler(listMessages));
chatRouter.get("/events", requireAuth, asyncHandler(streamChatEvents));
chatRouter.post("/messages", requireAuth, chatRateLimiter, asyncHandler(sendMessage));
chatRouter.post("/reset", requireAuth, chatRateLimiter, asyncHandler(resetConversation));
