import { Router } from "express";
import {
  getAttachmentContent,
  uploadAttachment,
} from "../controllers/attachment.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const attachmentRouter = Router();

attachmentRouter.post("/", requireAuth, asyncHandler(uploadAttachment));
attachmentRouter.get("/:id/content", requireAuth, asyncHandler(getAttachmentContent));
