import { Router } from "express";
import {
  getCiStatus,
  getCodeChanges,
  getMonitoring,
  getUsers,
  patchUserAdmin,
} from "../controllers/admin.controller.js";
import { requireAdmin } from "../middleware/admin.middleware.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);
adminRouter.get("/monitoring", asyncHandler(getMonitoring));
adminRouter.get("/ci-status", asyncHandler(getCiStatus));
adminRouter.get("/code-changes", asyncHandler(getCodeChanges));
adminRouter.get("/users", asyncHandler(getUsers));
adminRouter.patch("/users/:id/admin", asyncHandler(patchUserAdmin));
