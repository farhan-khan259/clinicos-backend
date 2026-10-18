#!/usr/bin/env bash
set -euo pipefail
# Run while the backend is stopped to keep uploads aligned with database records.
umask 077
backup_stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
backup_target="/backups/$backup_stamp"
mkdir -p "$backup_target/uploads"
backup_config="$(mktemp)"
trap 'rm -f "$backup_config"' EXIT
printf 'uri: "mongodb://clinic_backup:%s@mongo:27017/?authSource=admin&replicaSet=rs0"\n' "$MONGO_BACKUP_PASSWORD" > "$backup_config"
mongodump --config="$backup_config" --archive="$backup_target/database.archive.gz" --gzip --oplog
cp -a /uploads/. "$backup_target/uploads/"
sha256sum "$backup_target/database.archive.gz" > "$backup_target/SHA256SUMS"
printf 'Backup complete: %s\n' "$backup_target"
