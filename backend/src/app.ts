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
  app.use(express.json({ limit: "16kb" }));
  app.use(cookieParser());

  app.use("/api", apiRouter);
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
