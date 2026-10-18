import { config } from "dotenv";

// Support both documented backend-local configuration and the root .env used
// by Docker Compose. Existing process variables keep precedence in containers.
config({ quiet: true });
config({ path: new URL("../../../.env", import.meta.url), quiet: true });
export const env = {
  port: Number(process.env.PORT || 4000),
  mongo:
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/clinic_os?replicaSet=rs0",
  secret: process.env.JWT_SECRET,
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  production: process.env.NODE_ENV === "production",
  uploads: process.env.UPLOAD_DIR || "uploads",
};
if (!env.secret || env.secret.length < 32)
  throw new Error(
    "Set JWT_SECRET to a random secret of at least 32 characters.",
  );
