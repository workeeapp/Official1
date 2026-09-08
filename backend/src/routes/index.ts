import { Router } from "express";
import { authRouter } from "./auth.routes.js";
import { chatRouter } from "./chat.routes.js";
import { employeeRouter } from "./employee.routes.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/chat", chatRouter);
apiRouter.use("/employees", employeeRouter);

apiRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
