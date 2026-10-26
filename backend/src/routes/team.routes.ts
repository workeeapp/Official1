import { Router } from "express";
import { getTeam } from "../controllers/team.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const teamRouter = Router();

teamRouter.get("/", requireAuth, asyncHandler(getTeam));
