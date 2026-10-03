import { Router } from "express";
import { getEnv } from "../config/env.js";
import { prisma } from "../database/prisma.js";
import { authRouter } from "./auth.routes.js";
import { chatRouter } from "./chat.routes.js";
import { employeeRouter } from "./employee.routes.js";
import { whatsappRouter } from "./whatsapp.routes.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/chat", chatRouter);
apiRouter.use("/employees", employeeRouter);
apiRouter.use("/whatsapp", whatsappRouter);

/**
 * Cheap liveness for external uptime pings.
 * Checks process + DB only — not chat/WhatsApp/OpenAI live calls.
 */
apiRouter.get("/health", async (_req, res) => {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  const env = getEnv();
  const body = {
    status: db ? "ok" : "degraded",
    db,
    openaiConfigured: Boolean(env.OPENAI_API_KEY?.trim()),
    whatsappConfigured: Boolean(env.WHATSAPP_ACCESS_TOKEN?.trim()),
    opsAlertConfigured: Boolean(env.OPS_ALERT_PHONES?.trim()),
  };
  res.status(db ? 200 : 503).json(body);
});
