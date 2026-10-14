import { Router } from "express";
import { getAttachmentContent } from "../controllers/attachment.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const attachmentRouter = Router();

attachmentRouter.get("/:id/content", requireAuth, asyncHandler(getAttachmentContent));
