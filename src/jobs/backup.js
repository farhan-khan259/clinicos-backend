import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../config/env.js";
// Back up the whole multi-tenant database consistently and its protected files.
// Store completed backups on encrypted, access-restricted storage outside the server.
if (!process.env.BACKUP_MONGODB_URI)
  throw new Error(
    "Set BACKUP_MONGODB_URI to a backup-role account with no database in the URI path",
  );
const destination = path.resolve(
  process.env.BACKUP_DIR || "backups",
  new Date().toISOString().replaceAll(":", "-"),
);
await fs.mkdir(destination, { recursive: true, mode: 0o700 });
const config = path.join(destination, "dump-config.yml");
await fs.writeFile(
  config,
  `uri: ${JSON.stringify(process.env.BACKUP_MONGODB_URI)}\n`,
  { mode: 0o600 },
);
try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "mongodump",
      [
        "--config",
        config,
        "--archive=" + path.join(destination, "database.archive.gz"),
        "--gzip",
        "--oplog",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.on("error", () =>
      reject(Error("Install MongoDB Database Tools before running backups")),
    );
    child.stderr.on("data", () => {});
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              "Backup failed; check Mongo permissions, tool availability and replica set",
            ),
          ),
    );
  });
  await fs.mkdir(env.uploads, { recursive: true });
  await fs.cp(path.resolve(env.uploads), path.join(destination, "uploads"), {
    recursive: true,
    force: false,
  });
  const bytes = await fs.readFile(
    path.join(destination, "database.archive.gz"),
  );
  await fs.writeFile(
    path.join(destination, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        files: "uploads",
        format: "mongodump --oplog archive",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("Backup created: " + destination);
} finally {
  await fs.unlink(config).catch(() => {});
}
