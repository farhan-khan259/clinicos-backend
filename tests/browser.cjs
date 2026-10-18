const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
process.env.NODE_ENV = "development";
process.env.JWT_SECRET =
  "browser-test-only-clinic-secret-at-least-32-characters";
process.env.FRONTEND_URL = "http://127.0.0.1:5174";
process.env.API_PROXY_TARGET = "http://127.0.0.1:4001";
process.env.ADMIN_EMAIL = "admin@ahmed.demo";
process.env.ADMIN_PASSWORD = "AdminDemo123!";
process.env.LOG_REQUESTS = "false";
(async () => {
  let db, server, vite;
  const mongoose = require("mongoose");
  try {
    process.env.UPLOAD_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "clinic-browser-"),
    );
    await fs.mkdir("test-artifacts", { recursive: true });
    const { MongoMemoryReplSet } = require("mongodb-memory-server");
    db = await MongoMemoryReplSet.create({
      binary: { version: "7.0.14" },
      replSet: {
        count: 1,
        args: [
          "--nounixsocket",
          "--setParameter",
          "diagnosticDataCollectionEnabled=false",
        ],
      },
    });
    await mongoose.connect(db.getUri());
    const { allModels } = await import("../src/models/index.js");
    for (const m of allModels) await m.createIndexes();
    const { bootstrap } = await import("../src/seed.js");
    await bootstrap({ demo: true });
    const { app } = await import("../src/app.js");
    server = await new Promise((resolve, reject) => {
      const s = app.listen(4001, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    const { createServer } = await import(
      "../../frontend/node_modules/vite/dist/node/index.js"
    );
    vite = await createServer({
      root: path.resolve(__dirname, "../../frontend"),
      server: { host: "127.0.0.1", port: 5174, strictPort: true },
    });
    await vite.listen();
    await require("./browser-workflows.cjs")();
  } finally {
    if (vite) await vite.close();
    if (server) await new Promise((r) => server.close(r));
    await mongoose.disconnect();
    if (db) await db.stop();
    if (process.env.UPLOAD_DIR)
      await fs.rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
