import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { User, Refresh, Clinic } from "../models/index.js";
import { env } from "../config/env.js";
import { parse } from "../validators/index.js";
import { fail, hash, audit, transaction } from "../utils/domain.js";
import { authenticate } from "../middleware/auth.js";
export const auth = Router();
const options = {
  httpOnly: true,
  secure: env.production,
  sameSite: "strict",
  path: "/api/auth",
  maxAge: 7 * 86400000,
};
function access(user) {
  return jwt.sign(
    { sub: String(user._id), ver: user.authVersion || 0 },
    env.secret,
    { expiresIn: "15m", issuer: "ahmed-clinic", audience: "clinic-ui" },
  );
}
function publicUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    doctorId: user.doctorId,
    clinicId: user.clinicId,
    clinicalAccess: user.clinicalAccess,
    permissions: user.permissions,
    mustChangePassword: user.mustChangePassword,
  };
}
async function issue(user, res, family = crypto.randomUUID(), session) {
  const raw = crypto.randomBytes(48).toString("hex");
  await Refresh.create(
    [
      {
        userId: user._id,
        hash: hash(raw),
        family,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    ],
    { session },
  );
  res.cookie("clinicRefresh", raw, options);
  return {
    accessToken: access(user),
    user: publicUser(user),
    clinic: user.clinicId
      ? await Clinic.findById(user.clinicId).session(session || null)
      : null,
  };
}
function sameOrigin(req) {
  if (req.headers.origin && req.headers.origin !== env.origin)
    fail(403, "Untrusted request origin");
}
auth.post(
  "/login",
  rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  async (req, res) => {
    sameOrigin(req);
    const data = parse("login", req.body);
    const user = await User.findOne({ email: data.email.toLowerCase() }).select(
      "+passwordHash",
    );
    const valid = await bcrypt.compare(
      data.password,
      user?.passwordHash ||
        "$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    if (!user?.active || !valid) fail(401, "Email or password is incorrect");
    if (user.clinicId) {
      const clinic = await Clinic.findById(user.clinicId);
      if (
        !clinic ||
        clinic.status !== "active" ||
        clinic.expiresAt < new Date()
      )
        fail(403, "Clinic subscription is not active");
    }
    await audit({ user, tid: user.clinicId }, "login", "User", user._id);
    res.json(await issue(user, res));
  },
);
auth.post("/refresh", async (req, res) => {
  sameOrigin(req);
  const raw = req.cookies.clinicRefresh;
  if (!raw) fail(401, "Please sign in");
  let compromised = false;
  const result = await transaction(async (session) => {
    const record = await Refresh.findOne({ hash: hash(raw) }).session(session);
    if (!record || record.expiresAt < new Date()) fail(401, "Session expired");
    if (record.revokedAt) {
      await Refresh.updateMany(
        { family: record.family },
        { $set: { revokedAt: new Date() } },
        { session },
      );
      compromised = true;
      return null;
    }
    const user = await User.findById(record.userId).session(session);
    if (!user?.active) fail(401, "Account unavailable");
    record.revokedAt = new Date();
    await record.save({ session });
    return issue(user, res, record.family, session);
  });
  if (compromised) {
    res.clearCookie("clinicRefresh", options);
    fail(401, "Session revoked. Sign in again");
  }
  res.json(result);
});
auth.get("/me", authenticate, async (req, res) =>
  res.json({ user: publicUser(req.user), clinic: req.clinic || null }),
);
auth.post("/logout", async (req, res) => {
  sameOrigin(req);
  if (req.cookies.clinicRefresh)
    await Refresh.updateOne(
      { hash: hash(req.cookies.clinicRefresh) },
      { $set: { revokedAt: new Date() } },
    );
  res.clearCookie("clinicRefresh", options);
  res.json({ ok: true });
});
auth.post("/password", authenticate, async (req, res) => {
  const { currentPassword, password } = req.body;
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    fail(400, "New password must be 12–128 characters");
  const u = await User.findById(req.user._id).select("+passwordHash");
  if (!(await bcrypt.compare(currentPassword || "", u.passwordHash)))
    fail(400, "Current password is incorrect");
  await transaction(async (session) => {
    u.passwordHash = await bcrypt.hash(password, 12);
    u.mustChangePassword = false;
    u.authVersion = (u.authVersion || 0) + 1;
    await u.save({ session });
    await Refresh.updateMany(
      { userId: u._id },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    await audit(req, "password.changed", "User", u._id, {}, "", session);
  });
  res.json(await issue(u, res));
});
