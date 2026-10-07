import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { getEnv } from "./config/env.js";
import { apiRouter } from "./routes/index.js";
import { errorMiddleware, notFoundMiddleware } from "./middleware/error.middleware.js";
import { resolveFrontendDist } from "./utils/frontend-dist.js";

function clientOrigins(raw: string): string | string[] {
  const list = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (list.length === 0) {
    return "http://localhost:5173";
  }
  return list.length === 1 ? list[0]! : list;
}

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
      origin: clientOrigins(env.CLIENT_ORIGIN),
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

  // Resolve dist per request so a later `npm run build -w frontend` works without
  // restarting the API (createApp runs once at boot).
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    const frontendDist = resolveFrontendDist();
    if (!frontendDist) {
      next();
      return;
    }
    express.static(frontendDist, { index: false, fallthrough: true })(
      req,
      res,
      (error?: unknown) => {
        if (error) {
          next(error);
          return;
        }
        if (res.headersSent) {
          return;
        }
        res.sendFile(path.join(frontendDist, "index.html"), (sendError) => {
          if (sendError) {
            next(sendError);
          }
        });
      },
    );
  });

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
