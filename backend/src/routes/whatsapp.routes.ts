import { Router } from "express";
import { receiveWebhook, verifyWebhook } from "../controllers/whatsapp.controller.js";

export const whatsappRouter = Router();

whatsappRouter.get("/webhook", verifyWebhook);
whatsappRouter.post("/webhook", receiveWebhook);
