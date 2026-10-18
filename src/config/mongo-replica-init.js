// Executed by the mongo-init service; credentials are read from environment.
const adminDb = db.getSiblingDB("admin");
adminDb.auth(
  process.env.MONGO_INITDB_ROOT_USERNAME,
  process.env.MONGO_INITDB_ROOT_PASSWORD,
);
try {
  rs.status();
} catch (e) {
  if (e.codeName === "NotYetInitialized" || e.code === 94)
    rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] });
  else throw e;
}
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (db.hello().isWritablePrimary) {
    ready = true;
    break;
  }
  sleep(1000);
}
if (!ready) throw new Error("Replica set did not become primary");
print("Replica set initialized");
