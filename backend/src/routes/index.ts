import { Router } from "express";
import { attachmentRouter } from "./attachment.routes.js";
import { authRouter } from "./auth.routes.js";
import { chatRouter } from "./chat.routes.js";
import { employeeRouter } from "./employee.routes.js";
import { studioRouter } from "./studio.routes.js";
import { teamRouter } from "./team.routes.js";
import { tipRouter } from "./tip.routes.js";
import { whatsappRouter } from "./whatsapp.routes.js";

export const apiRouter = Router();

apiRouter.use("/attachments", attachmentRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/chat", chatRouter);
apiRouter.use("/employees", employeeRouter);
apiRouter.use("/studio", studioRouter);
apiRouter.use("/team", teamRouter);
apiRouter.use("/tips", tipRouter);
apiRouter.use("/whatsapp", whatsappRouter);

apiRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
