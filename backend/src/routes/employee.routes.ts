import { Router } from "express";
import {
  createEmployee,
  deleteEmployee,
  deleteEmployeeRecordItem,
  getConfigFileDefaults,
  getDigitalDefaults,
  getEmployeeRecords,
  getEmployeeUsage,
  getTeamUsage,
  listEmployees,
  removeEmployeeProfilePhoto,
  updateEmployee,
  updateEmployeeRecordItem,
  uploadEmployeeProfilePhoto,
} from "../controllers/employee.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const employeeRouter = Router();

employeeRouter.get("/", requireAuth, asyncHandler(listEmployees));
employeeRouter.get("/digital-defaults", requireAuth, asyncHandler(getDigitalDefaults));
employeeRouter.get("/config-defaults", requireAuth, asyncHandler(getConfigFileDefaults));
employeeRouter.get("/usage", requireAuth, asyncHandler(getTeamUsage));
employeeRouter.get("/:id/records", requireAuth, asyncHandler(getEmployeeRecords));
employeeRouter.get("/:id/usage", requireAuth, asyncHandler(getEmployeeUsage));
employeeRouter.patch("/:id/records/:itemId", requireAuth, asyncHandler(updateEmployeeRecordItem));
employeeRouter.delete("/:id/records/:itemId", requireAuth, asyncHandler(deleteEmployeeRecordItem));
employeeRouter.post(
  "/:id/profile-photo",
  requireAuth,
  asyncHandler(uploadEmployeeProfilePhoto),
);
employeeRouter.delete(
  "/:id/profile-photo",
  requireAuth,
  asyncHandler(removeEmployeeProfilePhoto),
);
employeeRouter.post("/", requireAuth, asyncHandler(createEmployee));
employeeRouter.patch("/:id", requireAuth, asyncHandler(updateEmployee));
employeeRouter.delete("/:id", requireAuth, asyncHandler(deleteEmployee));
