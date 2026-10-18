import mongoose from "mongoose";
import { env } from "./config/env.js";
import { app } from "./app.js";
import { allModels } from "./models/index.js";
await mongoose.connect(env.mongo, {
  autoIndex: !env.production,
  maxPoolSize: 15,
});
const hello = await mongoose.connection.db.admin().command({ hello: 1 });
if (!hello.setName && !hello.msg?.includes("isdbgrid"))
  throw new Error(
    "MongoDB replica set is required for transactional integrity. Use the supplied Docker setup.",
  );
for (const m of allModels) await m.createIndexes();
const server = app.listen(env.port, () =>
  console.log(`Clinic OS API listening on ${env.port}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
