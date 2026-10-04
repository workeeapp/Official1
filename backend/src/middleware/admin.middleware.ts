import { ForbiddenError, UnauthorizedError } from "../utils/errors.js";
import { findUserById, toPublicUser } from "../services/user.service.js";
import { asyncHandler } from "./async-handler.js";

/** Requires requireAuth first. Reloads isAdmin from DB (not JWT). */
export const requireAdmin = asyncHandler(async (req, _res, next) => {
  if (!req.user?.id) {
    throw new UnauthorizedError();
  }
  const row = await findUserById(req.user.id);
  if (!row || row.isAdmin !== true) {
    throw new ForbiddenError();
  }
  req.user = toPublicUser(row);
  next();
});
