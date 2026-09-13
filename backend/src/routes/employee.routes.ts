import { Router } from "express";
import {
  createEmployee,
  deleteEmployee,
  deleteEmployeeRecordItem,
  getEmployeeRecords,
  listEmployees,
  updateEmployee,
  updateEmployeeRecordItem,
} from "../controllers/employee.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const employeeRouter = Router();

employeeRouter.get("/", requireAuth, asyncHandler(listEmployees));
employeeRouter.get("/:id/records", requireAuth, asyncHandler(getEmployeeRecords));
employeeRouter.patch("/:id/records/:itemId", requireAuth, asyncHandler(updateEmployeeRecordItem));
employeeRouter.delete("/:id/records/:itemId", requireAuth, asyncHandler(deleteEmployeeRecordItem));
employeeRouter.post("/", requireAuth, asyncHandler(createEmployee));
employeeRouter.patch("/:id", requireAuth, asyncHandler(updateEmployee));
employeeRouter.delete("/:id", requireAuth, asyncHandler(deleteEmployee));
