import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { getEnv } from "./config/env.js";
import { apiRouter } from "./routes/index.js";
import { errorMiddleware, notFoundMiddleware } from "./middleware/error.middleware.js";

export function createApp() {
  const env = getEnv();
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get(["/privacy", "/data-deletion", "/terms"], (req, res) => {
    const isTerms = req.path === "/terms";
    const title = isTerms ? "Workee terms of service" : "Workee privacy";
    const body = isTerms
      ? "<p>Workee is a business assistant POC. By messaging our WhatsApp number you agree we may receive your message and reply to help with your request. Contact poc@workee.site.</p>"
      : "<p>Workee is a business assistant. When you message our WhatsApp number, we receive your phone number and message text so we can reply and handle your request.</p><p>To ask us to delete your data, email poc@workee.site and write “delete my data”.</p>";
    res
      .status(200)
      .type("html")
      .send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`);
  });

  app.use("/api", apiRouter);
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
