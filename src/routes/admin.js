import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  Clinic,
  User,
  Plan,
  Doctor,
  Audit,
  SupportGrant,
  Refresh,
} from "../models/index.js";
import { superadmin } from "../middleware/auth.js";
import { parse, reason } from "../validators/index.js";
import { fail, id, audit, transaction, page } from "../utils/domain.js";
export const admin = Router();
admin.use(superadmin);
admin.get("/dashboard", async (req, res) => {
  const clinics = await Clinic.find().lean();
  res.json({
    clinics: clinics.length,
    active: clinics.filter(
      (c) => c.status === "active" && c.expiresAt >= new Date(),
    ).length,
    suspended: clinics.filter((c) => c.status === "suspended").length,
    expired: clinics.filter((c) => c.expiresAt < new Date()).length,
    renewals: clinics.filter(
      (c) =>
        c.expiresAt >= new Date() &&
        c.expiresAt < new Date(Date.now() + 30 * 86400000),
    ).length,
    licensedUsers: await User.countDocuments({
      role: { $ne: "superadmin" },
      active: true,
    }),
    subscriptionRevenue: clinics.reduce(
      (s, c) =>
        s + c.subscriptionHistory.reduce((a, x) => a + (x.amount || 0), 0),
      0,
    ),
    recent: await Audit.find({ action: { $regex: "^admin\\." } })
      .select("-changes")
      .sort({ createdAt: -1 })
      .limit(15),
  });
});
admin.get("/clinics", async (req, res) => {
  const { p, size, skip } = page(req);
  res.json({
    items: await Clinic.find()
      .select("-logo")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(size),
    total: await Clinic.countDocuments(),
    page: p,
    limit: size,
  });
});
admin.post("/clinics", async (req, res) => {
  const data = parse("clinic", req.body);
  res.status(201).json(
    await transaction(async (session) => {
      const { password, email, ownerName, ...fields } = data;
      const [c] = await Clinic.create(
        [
          {
            ...fields,
            email,
            ownerName,
            subscriptionStart: new Date(),
            subscriptionHistory: [
              {
                start: new Date(),
                expiry: new Date(data.expiresAt),
                plan: data.plan,
                amount: 0,
                recordedAt: new Date(),
              },
            ],
          },
        ],
        { session },
      );
      const [u] = await User.create(
        [
          {
            clinicId: c._id,
            name: ownerName,
            email,
            passwordHash: await bcrypt.hash(password, 12),
            role: "owner",
            clinicalAccess: false,
          },
        ],
        { session },
      );
      await audit(
        { ...req, tid: c._id },
        "admin.clinic.created",
        "Clinic",
        c._id,
        { ownerId: u._id },
        "",
        session,
      );
      return c;
    }),
  );
});
admin.patch("/clinics/:id", async (req, res) => {
  const data = z
    .object({
      name: z.string().min(2).max(200),
      phone: z.string().max(100).optional(),
      address: z.string().max(300).optional(),
      status: z.enum(["active", "suspended"]),
      plan: z.string().min(1).max(100),
      expiresAt: z.iso.datetime({ offset: true }),
      doctorLimit: z.number().int().min(1).max(500),
      userLimit: z.number().int().min(1).max(2000),
    })
    .strict()
    .parse(req.body);
  res.json(
    await transaction(async (session) => {
      const c = await Clinic.findById(id(req.params.id)).session(session);
      if (!c) fail(404, "Clinic not found");
      if (
        data.doctorLimit <
          (await Doctor.countDocuments({ clinicId: c._id }).session(session)) ||
        data.userLimit <
          (await User.countDocuments({ clinicId: c._id, active: true }).session(
            session,
          ))
      )
        fail(409, "Limits cannot be below current usage");
      c.set(data);
      await c.save({ session });
      await audit(
        { ...req, tid: c._id },
        "admin.clinic.updated",
        "Clinic",
        c._id,
        { status: c.status },
        "",
        session,
      );
      return c;
    }),
  );
});
admin.post("/clinics/:id/renew", async (req, res) => {
  const data = z
    .object({
      expiresAt: z.iso.datetime({ offset: true }),
      plan: z.string().min(1).max(100),
      amount: z.number().int().min(0).max(100000000000),
    })
    .strict()
    .parse(req.body);
  res.json(
    await transaction(async (session) => {
      const c = await Clinic.findById(id(req.params.id)).session(session);
      if (!c) fail(404, "Clinic not found");
      if (new Date(data.expiresAt) <= c.expiresAt)
        fail(400, "Renewal must extend the expiry");
      c.subscriptionHistory.push({
        start: c.expiresAt,
        expiry: new Date(data.expiresAt),
        plan: data.plan,
        amount: data.amount,
        recordedAt: new Date(),
      });
      c.expiresAt = new Date(data.expiresAt);
      c.status = "active";
      c.plan = data.plan;
      await c.save({ session });
      await audit(
        { ...req, tid: c._id },
        "admin.subscription.renewed",
        "Clinic",
        c._id,
        { amount: data.amount },
        "",
        session,
      );
      return c;
    }),
  );
});
admin.post("/clinics/:id/reset-owner", async (req, res) => {
  const password = z.string().min(12).max(128).parse(req.body.password);
  const owner = await User.findOne({
    clinicId: id(req.params.id),
    role: "owner",
  });
  if (!owner) fail(404, "Owner not found");
  owner.passwordHash = await bcrypt.hash(password, 12);
  owner.mustChangePassword = true;
  owner.authVersion = (owner.authVersion || 0) + 1;
  await owner.save();
  await Refresh.updateMany(
    { userId: owner._id },
    { $set: { revokedAt: new Date() } },
  );
  await audit(
    { ...req, tid: owner.clinicId },
    "admin.owner.reset",
    "User",
    owner._id,
  );
  res.json({ ok: true, email: owner.email });
});
admin.get("/clinics/:id/usage", async (req, res) => {
  const clinicId = id(req.params.id);
  res.json({
    doctors: await Doctor.countDocuments({ clinicId }),
    users: await User.countDocuments({ clinicId, active: true }),
  });
});
const planSchema = z
  .object({
    name: z.string().min(2).max(100),
    months: z.number().int().min(1).max(36),
    doctorLimit: z.number().int().min(1).max(500),
    userLimit: z.number().int().min(1).max(2000),
    price: z.number().int().min(0).max(100000000000),
    active: z.boolean(),
  })
  .strict();
admin.get("/plans", async (req, res) => res.json(await Plan.find().lean()));
admin.post("/plans", async (req, res) => {
  const d = await Plan.create(planSchema.parse(req.body));
  await audit(req, "admin.plan.created", "Plan", d._id);
  res.status(201).json(d);
});
admin.put("/plans/:id", async (req, res) => {
  const p = await Plan.findById(id(req.params.id));
  if (!p) fail(404, "Plan not found");
  p.set(planSchema.parse(req.body));
  await p.save();
  await audit(req, "admin.plan.updated", "Plan", p._id);
  res.json(p);
});
admin.get("/activity", async (req, res) =>
  res.json(
    await Audit.find({ action: { $regex: "^admin\\." } })
      .select("-changes")
      .sort({ createdAt: -1 })
      .limit(100),
  ),
);
admin.get("/support/:clinicId", async (req, res) => {
  const clinicId = id(req.params.clinicId);
  const grant = await SupportGrant.findOne({
    clinicId,
    adminId: req.user._id,
    expiresAt: { $gt: new Date() },
    revokedAt: { $exists: false },
  });
  if (!grant) fail(403, "Clinic-approved support grant required");
  await audit(
    { ...req, tid: clinicId },
    "admin.support.used",
    "SupportGrant",
    grant._id,
    {},
    grant.reason,
  );
  res.json({
    grant,
    clinic: await Clinic.findById(clinicId).select(
      "name timezone language settings status expiresAt",
    ),
    users: await User.find({ clinicId }).select("name role active"),
    usage: { doctors: await Doctor.countDocuments({ clinicId }) },
  });
});
