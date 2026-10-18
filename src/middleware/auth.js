import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { Clinic, User, Appointment, Consultation } from "../models/index.js";
import { fail, id } from "../utils/domain.js";
const roles = {
  owner: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "doctors:read",
    "doctors:write",
    "billing:read",
    "billing:write",
    "finance:read",
    "finance:write",
    "reports:read",
    "settings:write",
    "users:write",
    "audit:read",
  ],
  manager: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "doctors:read",
    "doctors:write",
    "reports:read",
    "users:write",
  ],
  doctor: [
    "patients:read",
    "appointments:read",
    "appointments:write",
    "doctors:read",
    "clinical:read",
    "clinical:write",
    "reports:read",
  ],
  receptionist: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "doctors:read",
    "billing:read",
    "billing:write",
  ],
  accountant: [
    "patients:read",
    "doctors:read",
    "billing:read",
    "billing:write",
    "finance:read",
    "finance:write",
    "reports:read",
  ],
};
export function has(req, permission) {
  return (
    (roles[req.user.role] || []).includes(permission) ||
    (req.user.permissions || []).includes(permission)
  );
}
export function clinical(req) {
  return req.user.role === "doctor" || req.user.clinicalAccess === true;
}
export async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) fail(401, "Please sign in");
    let payload;
    try {
      payload = jwt.verify(token, env.secret, {
        algorithms: ["HS256"],
        issuer: "ahmed-clinic",
        audience: "clinic-ui",
      });
    } catch {
      fail(401, "Session expired");
    }
    req.user = await User.findById(payload.sub);
    if (!req.user?.active) fail(401, "Account unavailable");
    if (payload.ver !== (req.user.authVersion || 0))
      fail(401, "Session revoked");
    if (req.user.role !== "superadmin") {
      req.tid = req.user.clinicId;
      req.clinic = await Clinic.findById(req.tid);
      if (!req.clinic || req.clinic.status !== "active")
        fail(403, "Clinic subscription is suspended");
      if (req.clinic.expiresAt < new Date())
        fail(403, "Clinic subscription has expired");
    }
    if (
      req.user.mustChangePassword &&
      !["/api/auth/me", "/api/auth/password", "/api/auth/logout"].includes(
        req.originalUrl.split("?")[0],
      )
    )
      fail(403, "Change your temporary password before continuing");
    next();
  } catch (e) {
    next(e);
  }
}
export const permit = (p) => (req, res, next) => {
  try {
    if (!req.tid || !has(req, p))
      fail(403, "You do not have permission for this action");
    next();
  } catch (e) {
    next(e);
  }
};
export const medical = (req, res, next) => {
  try {
    if (!req.tid || !clinical(req))
      fail(403, "Clinical records are restricted");
    next();
  } catch (e) {
    next(e);
  }
};
export const prescriber = (req, res, next) => {
  try {
    if (req.user.role !== "doctor" || !req.user.doctorId)
      fail(403, "Only a linked doctor may approve clinical records");
    next();
  } catch (e) {
    next(e);
  }
};
export const superadmin = (req, res, next) => {
  try {
    if (req.user.role !== "superadmin")
      fail(403, "Ahmed Solutions administrator only");
    next();
  } catch (e) {
    next(e);
  }
};
export function ownDoctor(req, doctorId) {
  if (
    req.user.role === "doctor" &&
    String(req.user.doctorId) !== String(doctorId)
  )
    fail(403, "This encounter is assigned to another doctor");
}
export async function patientAccess(req, patientId) {
  id(String(patientId));
  if (req.user.role === "doctor") {
    const exists = await Appointment.exists({
      clinicId: req.tid,
      patientId,
      doctorId: req.user.doctorId,
    });
    if (!exists) fail(403, "Patient is not assigned to this doctor");
  }
}
export const scoped = (req) => ({ clinicId: req.tid });
