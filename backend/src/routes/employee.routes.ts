import { Router } from "express";
import {
  createEmployee,
  deleteEmployee,
  listEmployees,
  updateEmployee,
} from "../controllers/employee.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const employeeRouter = Router();

employeeRouter.get("/", requireAuth, asyncHandler(listEmployees));
employeeRouter.post("/", requireAuth, asyncHandler(createEmployee));
employeeRouter.patch("/:id", requireAuth, asyncHandler(updateEmployee));
employeeRouter.delete("/:id", requireAuth, asyncHandler(deleteEmployee));
