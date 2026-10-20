import { Router } from "express";
import {
  createTip,
  deleteTip,
  listTips,
  updateTip,
} from "../controllers/tip.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const tipRouter = Router();

tipRouter.get("/", requireAuth, asyncHandler(listTips));
tipRouter.post("/", requireAuth, asyncHandler(createTip));
tipRouter.patch("/:id", requireAuth, asyncHandler(updateTip));
tipRouter.delete("/:id", requireAuth, asyncHandler(deleteTip));
