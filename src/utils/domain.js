import mongoose from "mongoose";
import crypto from "node:crypto";
import { Counter, Audit, Journal, Lock } from "../models/index.js";
export function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
export const id = (v) =>
  mongoose.isValidObjectId(v) && typeof v === "string"
    ? v
    : fail(400, "Invalid identifier");
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const hash = (data) =>
  crypto
    .createHash("sha256")
    .update(typeof data === "string" ? data : JSON.stringify(data))
    .digest("hex");
export async function transaction(fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(() => fn(session));
    } catch (e) {
      if (e.code !== 11000 || attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
    } finally {
      await session.endSession();
    }
  }
}
export async function next(clinicId, key, session) {
  return (
    await Counter.findOneAndUpdate(
      { clinicId, key },
      { $inc: { value: 1 } },
      { upsert: true, new: true, session },
    )
  ).value;
}
export async function serial(clinicId, key, session) {
  await Lock.findOneAndUpdate(
    { clinicId, key },
    { $inc: { version: 1 } },
    { upsert: true, new: true, session },
  );
}
export async function audit(
  req,
  action,
  entity,
  entityId,
  changes = {},
  reason = "",
  session,
) {
  await Audit.create(
    [
      {
        clinicId: req.tid,
        actorId: req.user._id,
        action,
        entity,
        entityId: String(entityId),
        changes,
        reason,
      },
    ],
    { session },
  );
}
export async function journal(req, data, session) {
  await Journal.create(
    [{ clinicId: req.tid, authorId: req.user._id, ...data }],
    { session },
  );
}
export function localDate(date, tz = "Asia/Karachi") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function localParts(date, tz) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return {
    time: `${get("hour")}:${get("minute")}`,
    day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      get("weekday"),
    ),
  };
}
export function zonedMidnight(day, tz) {
  const base = new Date(`${day}T00:00:00Z`);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  })
    .formatToParts(base)
    .find((p) => p.type === "timeZoneName").value;
  const match = p.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offset = match
    ? (match[1] === "+" ? 1 : -1) * (+match[2] * 60 + +match[3])
    : 0;
  return new Date(base.getTime() - offset * 60000);
}
export function range(req) {
  const today = localDate(new Date(), req.clinic.timezone);
  const from = req.query.from || today;
  const to = req.query.to || today;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    from > to
  )
    fail(400, "Invalid date range");
  const start = zonedMidnight(from, req.clinic.timezone);
  const end = zonedMidnight(to, req.clinic.timezone);
  end.setUTCDate(end.getUTCDate() + 1);
  if (end - start > 366 * 86400000) fail(400, "Choose a range within one year");
  return { from, to, start, end };
}
export function page(req) {
  const p = Math.max(1, parseInt(req.query.page) || 1),
    size = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  return { p, size, skip: (p - 1) * size };
}
export function snapshot(record) {
  const d = record.toObject();
  delete d.versions;
  delete d.__v;
  return d;
}
export const clinicalFields = [
  "allergies",
  "medicalHistory",
  "conditions",
  "surgeries",
  "medications",
  "notes",
];
export const patientProjection = (clinical) =>
  clinical
    ? ""
    : "-allergies -medicalHistory -conditions -surgeries -medications -notes -cnic";
