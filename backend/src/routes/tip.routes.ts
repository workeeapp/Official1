import { Router } from "express";
import {
  createTip,
  deleteTip,
  listTips,
  sendTip,
  updateTip,
} from "../controllers/tip.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const tipRouter = Router();

tipRouter.get("/", requireAuth, asyncHandler(listTips));
tipRouter.post("/", requireAuth, asyncHandler(createTip));
tipRouter.post("/:id/send", requireAuth, asyncHandler(sendTip));
tipRouter.patch("/:id", requireAuth, asyncHandler(updateTip));
tipRouter.delete("/:id", requireAuth, asyncHandler(deleteTip));
