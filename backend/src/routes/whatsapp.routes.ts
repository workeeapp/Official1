import { Router } from "express";
import {
  getWhatsAppStatus,
  receiveWebhook,
  verifyWebhook,
} from "../controllers/whatsapp.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const whatsappRouter = Router();

whatsappRouter.get("/status", requireAuth, asyncHandler(getWhatsAppStatus));
whatsappRouter.get("/webhook", verifyWebhook);
whatsappRouter.post("/webhook", receiveWebhook);
