// Executed by mongosh during first initialization of the database volume.
const appPassword = process.env.MONGO_APP_PASSWORD;
if (!appPassword || appPassword.length < 16)
  throw new Error("Set a Mongo application password of at least 16 characters");
db.getSiblingDB("clinic_os").createUser({
  user: "clinic_app",
  pwd: appPassword,
  roles: [{ role: "readWrite", db: "clinic_os" }],
});

if (process.env.MONGO_BACKUP_PASSWORD)
  db.getSiblingDB("admin").createUser({
    user: "clinic_backup",
    pwd: process.env.MONGO_BACKUP_PASSWORD,
    roles: [{ role: "backup", db: "admin" }],
  });
