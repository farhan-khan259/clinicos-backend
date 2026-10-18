import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import crypto from "node:crypto";
import { env } from "./config/env.js";
import { authenticate } from "./middleware/auth.js";
import { auth } from "./routes/auth.js";
import { clinic } from "./routes/clinic.js";
import { finance } from "./routes/finance.js";
import { reports } from "./routes/reports.js";
import { admin } from "./routes/admin.js";
export const app = express();
app.disable("x-powered-by");
if (env.production) app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: env.origin, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.set("X-Request-ID", req.requestId);
  res.set("Cache-Control", "no-store");
  const start = Date.now();
  res.on("finish", () => {
    if (process.env.LOG_REQUESTS !== "false")
      console.log(
        JSON.stringify({
          level: "info",
          id: req.requestId,
          method: req.method,
          route: req.route?.path || req.path.replace(/[0-9a-f]{24}/g, ":id"),
          status: res.statusCode,
          ms: Date.now() - start,
        }),
      );
  });
  next();
});
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.get("/api/health", (req, res) =>
  res.json({ ok: true, service: "Clinic OS" }),
);
app.use("/api/auth", auth);
app.use("/api", authenticate);
app.use("/api/admin", admin);
app.use(
  "/api",
  (req, res, next) => {
    if (!req.tid)
      return res.status(403).json({ message: "Clinic account required" });
    next();
  },
  clinic,
  finance,
  reports,
);
app.use((req, res) => res.status(404).json({ message: "Endpoint not found" }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = err.status || 500,
    message = err.message;
  if (err.name === "ZodError") {
    status = 400;
    message = err.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  }
  if (err.code === 11000) {
    status = 409;
    message =
      "This record already exists or was processed. Refresh and try again.";
  }
  if (["ValidationError", "StrictModeError", "CastError"].includes(err.name)) {
    status = 400;
    message = "Invalid record fields";
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    status = 400;
    message = "File is too large (maximum 10 MB)";
  }
  if (status >= 500) {
    console.error(
      JSON.stringify({
        level: "error",
        id: req.requestId,
        type: err.name,
        code: err.code,
      }),
    );
    message = "The request could not be completed. Please try again.";
  }
  res.status(status).json({ message, requestId: req.requestId });
});
