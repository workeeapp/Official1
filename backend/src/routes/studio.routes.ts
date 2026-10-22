import { Router } from "express";
import {
  getCase,
  getCases,
  getDraft,
  getDrafts,
  getRun,
  getRuns,
  getSafety,
  getTracks,
  postCompileDraft,
  postPromoteDraft,
  postRun,
  postValidateDraft,
  putDraft,
} from "../controllers/studio.controller.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export const studioRouter = Router();

studioRouter.use(requireAuth);

studioRouter.get("/tracks", asyncHandler(getTracks));
studioRouter.get("/safety", asyncHandler(getSafety));
studioRouter.get("/cases", asyncHandler(getCases));
studioRouter.get("/cases/:id", asyncHandler(getCase));
studioRouter.get("/runs", asyncHandler(getRuns));
studioRouter.get("/runs/:id", asyncHandler(getRun));
studioRouter.post("/runs", asyncHandler(postRun));
studioRouter.get("/drafts", asyncHandler(getDrafts));
studioRouter.get("/drafts/:id", asyncHandler(getDraft));
studioRouter.put("/drafts/:id", asyncHandler(putDraft));
studioRouter.post("/drafts/compile", asyncHandler(postCompileDraft));
studioRouter.post("/drafts/validate", asyncHandler(postValidateDraft));
studioRouter.post("/drafts/promote", asyncHandler(postPromoteDraft));
