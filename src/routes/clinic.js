import { Router } from "express";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  Patient,
  Doctor,
  Appointment,
  Consultation,
  Prescription,
  Document,
  Clinic,
  User,
  Refresh,
  Audit,
  SupportGrant,
  Expense,
} from "../models/index.js";
import {
  permit,
  medical,
  prescriber,
  ownDoctor,
  patientAccess,
  clinical,
  has,
} from "../middleware/auth.js";
import { parse, reason } from "../validators/index.js";
import {
  fail,
  id,
  escapeRegex,
  page,
  audit,
  transaction,
  next,
  serial,
  localDate,
  localParts,
  patientProjection,
  clinicalFields,
  snapshot,
  hash,
} from "../utils/domain.js";
export const clinic = Router();
const get = async (Model, req, key, session) => {
  const record = await Model.findOne({
    _id: id(key),
    clinicId: req.tid,
  }).session(session || null);
  if (!record) fail(404, "Record not found");
  return record;
};
async function list(Model, req, filter = {}, projection = "") {
  const { p, size, skip } = page(req);
  const q = { clinicId: req.tid, ...filter };
  const [items, total] = await Promise.all([
    Model.find(q)
      .select(projection)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(size)
      .lean(),
    Model.countDocuments(q),
  ]);
  return { items, total, page: p, limit: size };
}
function publicPatient(req, p) {
  const d = p.toObject ? p.toObject() : p;
  if (!clinical(req)) {
    clinicalFields.forEach((k) => delete d[k]);
    delete d.cnic;
  }
  return d;
}
clinic.get("/patients", permit("patients:read"), async (req, res) => {
  const q = { archivedAt: { $exists: false } };
  if (req.query.q) {
    const re = new RegExp(escapeRegex(String(req.query.q).slice(0, 100)), "i");
    q.$or = [{ name: re }, { mobile: re }, { mrn: re }];
  }
  if (req.user.role === "doctor") {
    q._id = {
      $in: await Appointment.distinct("patientId", {
        clinicId: req.tid,
        doctorId: req.user.doctorId,
      }),
    };
  }
  const result = await list(Patient, req, q, patientProjection(clinical(req)));
  res.json(result);
});
clinic.get("/patients/matches", permit("patients:write"), async (req, res) => {
  const matches = [];
  if (req.query.mobile) matches.push({ mobile: String(req.query.mobile) });
  if (req.query.name)
    matches.push({
      name: new RegExp(
        `^${escapeRegex(String(req.query.name).slice(0, 100))}$`,
        "i",
      ),
    });
  res.json(
    matches.length
      ? await Patient.find({ clinicId: req.tid, $or: matches })
          .select("name mobile mrn age dob gender")
          .limit(10)
      : [],
  );
});
clinic.post("/patients", permit("patients:write"), async (req, res) => {
  const data = parse("patient", req.body);
  if (!clinical(req)) clinicalFields.forEach((f) => delete data[f]);
  const patient = await transaction(async (session) => {
    const n = await next(req.tid, "patient", session);
    const [p] = await Patient.create(
      [{ clinicId: req.tid, mrn: `P-${String(n).padStart(6, "0")}`, ...data }],
      { session },
    );
    await audit(req, "patient.created", "Patient", p._id, {}, "", session);
    return p;
  });
  res.status(201).json(publicPatient(req, patient));
});
clinic.get("/patients/:id", permit("patients:read"), async (req, res) => {
  await patientAccess(req, req.params.id);
  const p = await get(Patient, req, req.params.id);
  await audit(req, "patient.viewed", "Patient", p._id);
  const data = p.toObject();
  if (!clinical(req)) {
    clinicalFields.forEach((f) => delete data[f]);
    delete data.cnic;
  }
  res.json(data);
});
clinic.patch("/patients/:id", permit("patients:write"), async (req, res) => {
  const data = parse("patient", req.body);
  if (!clinical(req)) clinicalFields.forEach((f) => delete data[f]);
  const result = await transaction(async (session) => {
    const p = await get(Patient, req, req.params.id, session);
    if (p.archivedAt) fail(409, "Archived patient is read only");
    const before = snapshot(p);
    p.set(data);
    await p.save({ session });
    await audit(
      req,
      "patient.updated",
      "Patient",
      p._id,
      { before, after: snapshot(p) },
      "",
      session,
    );
    return p;
  });
  res.json(publicPatient(req, result));
});
clinic.post(
  "/patients/:id/archive",
  permit("settings:write"),
  async (req, res) => {
    const why = reason(req.body);
    const cutoff = new Date(
      Date.now() - req.clinic.settings.retentionDays * 86400000,
    );
    const result = await transaction(async (session) => {
      const p = await get(Patient, req, req.params.id, session);
      const recent = await Appointment.exists({
        clinicId: req.tid,
        patientId: p._id,
        startAt: { $gte: cutoff },
      }).session(session);
      if (p.createdAt > cutoff || recent)
        fail(409, "Record is within the clinic retention period");
      p.archivedAt = new Date();
      p.archiveReason = why;
      await p.save({ session });
      await audit(req, "patient.archived", "Patient", p._id, {}, why, session);
      return p;
    });
    res.json(result);
  },
);
clinic.get(
  "/patients/:id/history",
  permit("patients:read"),
  async (req, res) => {
    await patientAccess(req, req.params.id);
    const patient = await get(Patient, req, req.params.id);
    const q = { clinicId: req.tid, patientId: patient._id };
    const { p: pageNumber, size, skip } = page(req);
    const totals = { appointments: await Appointment.countDocuments(q) };
    const appointments = await Appointment.find(q)
      .sort({ startAt: -1 })
      .skip(skip)
      .limit(size)
      .lean();
    const result = { appointments, page: pageNumber, limit: size, totals };
    if (clinical(req)) {
      totals.consultations = await Consultation.countDocuments(q);
      totals.prescriptions = await Prescription.countDocuments(q);
      totals.documents = await Document.countDocuments(q);
      result.consultations = await Consultation.find(q)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(size)
        .lean();
      result.prescriptions = await Prescription.find(q)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(size)
        .lean();
      result.documents = await Document.find(q)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(size)
        .lean();
      await audit(req, "clinical.history.viewed", "Patient", patient._id);
    }
    res.json(result);
  },
);
clinic.get("/doctors", permit("doctors:read"), async (req, res) =>
  res.json(await list(Doctor, req, {}, "-favorites")),
);
clinic.get("/doctors/:id", permit("doctors:read"), async (req, res) => {
  const d = await get(Doctor, req, req.params.id);
  const data = d.toObject();
  if (req.user.role === "doctor" && String(d._id) !== String(req.user.doctorId))
    delete data.favorites;
  res.json(data);
});
clinic.post("/doctors", permit("doctors:write"), async (req, res) => {
  const data = parse("doctor", req.body);
  res.status(201).json(
    await transaction(async (session) => {
      await serial(req.tid, "doctor-limit", session);
      if (
        (await Doctor.countDocuments({ clinicId: req.tid }).session(session)) >=
        req.clinic.doctorLimit
      )
        fail(409, "Subscription doctor limit reached");
      const [d] = await Doctor.create([{ clinicId: req.tid, ...data }], {
        session,
      });
      await audit(req, "doctor.created", "Doctor", d._id, {}, "", session);
      return d;
    }),
  );
});
clinic.patch("/doctors/:id", permit("doctors:write"), async (req, res) => {
  const data = parse("doctor", req.body);
  res.json(
    await transaction(async (session) => {
      const d = await get(Doctor, req, req.params.id, session);
      const before = snapshot(d);
      d.set(data);
      await d.save({ session });
      await audit(
        req,
        "doctor.updated",
        "Doctor",
        d._id,
        { before, after: snapshot(d) },
        "",
        session,
      );
      return d;
    }),
  );
});
clinic.put("/doctors/:id/favorites", prescriber, async (req, res) => {
  ownDoctor(req, req.params.id);
  const favorites = z
    .array(
      z
        .object({
          name: z.string().min(1).max(200),
          strength: z.string().max(200).optional(),
          formulation: z.string().max(100).optional(),
          route: z.string().max(100).optional(),
          instructions: z.string().max(1000).optional(),
        })
        .strict(),
    )
    .max(100)
    .parse(req.body);
  const d = await get(Doctor, req, req.params.id);
  d.favorites = favorites;
  await d.save();
  await audit(req, "medicine.favorites.updated", "Doctor", d._id);
  res.json(d.favorites);
});
async function slot(req, data, session, exclude) {
  const d = await get(Doctor, req, data.doctorId, session);
  if (!d.active) fail(400, "Doctor is inactive");
  const start = new Date(data.startAt),
    end = new Date(start.getTime() + d.duration * 60000);
  const day = localDate(start, req.clinic.timezone);
  const parts = localParts(start, req.clinic.timezone),
    finish = localParts(end, req.clinic.timezone);
  if (d.leaves.some((l) => l.date === day)) fail(409, "Doctor is on leave");
  if (
    !d.sessions.some(
      (s) =>
        s.days.includes(parts.day) &&
        parts.time >= s.start &&
        finish.time <= s.end &&
        localDate(end, req.clinic.timezone) === day,
    )
  )
    fail(409, "Choose a time inside doctor availability");
  await serial(req.tid, `slots:${d._id}:${day}`, session);
  if (!req.clinic.settings.allowOverbooking) {
    const q = {
      clinicId: req.tid,
      doctorId: d._id,
      status: { $nin: ["Cancelled", "No Show"] },
      startAt: { $lt: end },
      endAt: { $gt: start },
    };
    if (exclude) q._id = { $ne: exclude };
    if (await Appointment.exists(q).session(session))
      fail(409, "This time overlaps an existing appointment");
  }
  return { startAt: start, endAt: end, localDate: day };
}
clinic.get("/appointments", permit("appointments:read"), async (req, res) => {
  const q = {};
  if (req.query.date) q.localDate = String(req.query.date);
  if (req.query.doctorId) q.doctorId = id(req.query.doctorId);
  if (req.query.status) q.status = String(req.query.status);
  if (req.user.role === "doctor") q.doctorId = req.user.doctorId;
  const { p, size, skip } = page(req);
  const filter = { clinicId: req.tid, ...q };
  const [items, total] = await Promise.all([
    Appointment.find(filter).sort({ startAt: 1 }).skip(skip).limit(size).lean(),
    Appointment.countDocuments(filter),
  ]);
  const ps = await Patient.find({
    clinicId: req.tid,
    _id: { $in: items.map((a) => a.patientId) },
  })
    .select("name mrn mobile")
    .lean();
  const ds = await Doctor.find({
    clinicId: req.tid,
    _id: { $in: items.map((a) => a.doctorId) },
  })
    .select("name")
    .lean();
  res.json({
    items: items.map((a) => ({
      ...a,
      patient: ps.find((p) => String(p._id) === String(a.patientId)),
      doctor: ds.find((d) => String(d._id) === String(a.doctorId)),
    })),
    total,
    page: p,
    limit: size,
  });
});
clinic.post("/appointments", permit("appointments:write"), async (req, res) => {
  const data = parse("appointment", req.body);
  ownDoctor(req, data.doctorId);
  res.status(201).json(
    await transaction(async (session) => {
      const p = await get(Patient, req, data.patientId, session);
      if (p.archivedAt) fail(409, "Patient is archived");
      const times = await slot(req, data, session);
      const [a] = await Appointment.create(
        [{ clinicId: req.tid, ...data, ...times }],
        { session },
      );
      await audit(
        req,
        "appointment.created",
        "Appointment",
        a._id,
        {},
        "",
        session,
      );
      return a;
    }),
  );
});
clinic.patch(
  "/appointments/:id",
  permit("appointments:write"),
  async (req, res) => {
    const data = parse("appointment", req.body);
    ownDoctor(req, data.doctorId);
    res.json(
      await transaction(async (session) => {
        const a = await get(Appointment, req, req.params.id, session);
        ownDoctor(req, a.doctorId);
        if (a.status !== "Scheduled")
          fail(409, "Only scheduled appointments can be rescheduled");
        const p = await get(Patient, req, data.patientId, session);
        if (p.archivedAt) fail(409, "Patient is archived");
        const times = await slot(req, data, session, a._id);
        a.set({ ...data, ...times });
        await a.save({ session });
        await audit(
          req,
          "appointment.rescheduled",
          "Appointment",
          a._id,
          {},
          "",
          session,
        );
        return a;
      }),
    );
  },
);
clinic.post(
  "/appointments/:id/check-in",
  permit("appointments:write"),
  async (req, res) => {
    res.json(
      await transaction(async (session) => {
        const a = await get(Appointment, req, req.params.id, session);
        ownDoctor(req, a.doctorId);
        if (a.token) return a;
        if (a.status !== "Scheduled")
          fail(409, "Appointment cannot be checked in");
        if (a.localDate !== localDate(new Date(), req.clinic.timezone))
          fail(409, "Check in is available on the appointment date");
        const n = await next(
          req.tid,
          `tokens:${a.doctorId}:${a.localDate}`,
          session,
        );
        a.token = `${req.clinic.settings.tokenPrefix}-${String(n).padStart(3, "0")}`;
        a.queueOrder = n;
        a.status = "Waiting";
        a.checkedInAt = new Date();
        a.queueEvents.push({
          action: "check-in",
          at: new Date(),
          userId: req.user._id,
        });
        await a.save({ session });
        await audit(
          req,
          "appointment.checked-in",
          "Appointment",
          a._id,
          {},
          "",
          session,
        );
        return a;
      }),
    );
  },
);
clinic.post(
  "/appointments/:id/status",
  permit("appointments:write"),
  async (req, res) => {
    const status = z
      .enum(["Cancelled", "No Show", "Waiting"])
      .parse(req.body.status);
    const why = reason(req.body);
    res.json(
      await transaction(async (session) => {
        const a = await get(Appointment, req, req.params.id, session);
        ownDoctor(req, a.doctorId);
        if (
          a.status === "Completed" ||
          (a.status === "In Consultation" && status !== "Waiting")
        )
          fail(409, "Cannot change status during or after a consultation");
        if (status === "Waiting" && !a.token) fail(409, "Check in first");
        a.status = status;
        if (status === "Waiting")
          a.queueOrder =
            (await next(
              req.tid,
              `queue:${a.doctorId}:${a.localDate}`,
              session,
            )) + 100000;
        a.queueEvents.push({
          action: status,
          reason: why,
          at: new Date(),
          userId: req.user._id,
        });
        await a.save({ session });
        await audit(
          req,
          "appointment.status",
          "Appointment",
          a._id,
          { status },
          why,
          session,
        );
        return a;
      }),
    );
  },
);
clinic.get("/queue", permit("appointments:read"), async (req, res) => {
  const q = {
    clinicId: req.tid,
    localDate: localDate(new Date(), req.clinic.timezone),
    status: { $in: ["Waiting", "Checked In", "In Consultation"] },
  };
  if (req.user.role === "doctor") q.doctorId = req.user.doctorId;
  else if (req.query.doctorId) q.doctorId = id(req.query.doctorId);
  const items = await Appointment.find(q).sort({ queueOrder: 1 }).lean();
  const ps = await Patient.find({
    clinicId: req.tid,
    _id: { $in: items.map((a) => a.patientId) },
  })
    .select("name mrn")
    .lean();
  res.json(
    items.map((a, i) => ({
      ...a,
      position: i + 1,
      patient: ps.find((p) => String(p._id) === String(a.patientId)),
    })),
  );
});
clinic.post(
  "/queue/:doctorId/next",
  permit("appointments:write"),
  async (req, res) => {
    ownDoctor(req, req.params.doctorId);
    await get(Doctor, req, req.params.doctorId);
    res.json(
      await transaction(async (session) => {
        const day = localDate(new Date(), req.clinic.timezone);
        await serial(
          req.tid,
          `queue-call:${req.params.doctorId}:${day}`,
          session,
        );
        if (
          await Appointment.exists({
            clinicId: req.tid,
            doctorId: req.params.doctorId,
            localDate: day,
            status: "In Consultation",
          }).session(session)
        )
          fail(409, "Finish the current consultation first");
        const a = await Appointment.findOne({
          clinicId: req.tid,
          doctorId: req.params.doctorId,
          localDate: day,
          status: "Waiting",
        })
          .sort({ queueOrder: 1 })
          .session(session);
        if (!a) fail(404, "No waiting patients");
        a.calledAt = new Date();
        a.status = "In Consultation";
        a.queueEvents.push({
          action: "called",
          at: new Date(),
          userId: req.user._id,
        });
        await a.save({ session });
        await audit(req, "queue.called", "Appointment", a._id, {}, "", session);
        return a;
      }),
    );
  },
);
clinic.get("/consultations", medical, async (req, res) => {
  const q = {};
  if (req.user.role === "doctor") q.doctorId = req.user.doctorId;
  if (req.query.patientId) {
    await patientAccess(req, req.query.patientId);
    q.patientId = id(req.query.patientId);
  }
  res.json(await list(Consultation, req, q));
});
clinic.get("/consultations/:id", medical, async (req, res) => {
  const c = await get(Consultation, req, req.params.id);
  await patientAccess(req, String(c.patientId));
  await audit(req, "consultation.viewed", "Consultation", c._id);
  res.json(c);
});
clinic.post("/consultations/start", prescriber, async (req, res) => {
  const appointmentId = id(req.body.appointmentId);
  res.json(
    await transaction(async (session) => {
      const a = await get(Appointment, req, appointmentId, session);
      ownDoctor(req, a.doctorId);
      const existing = await Consultation.findOne({
        clinicId: req.tid,
        appointmentId,
      }).session(session);
      if (existing?.status === "signed") return existing;
      if (!["Waiting", "In Consultation", "Checked In"].includes(a.status))
        fail(409, "Check in the patient first");
      await serial(req.tid, `queue-call:${a.doctorId}:${a.localDate}`, session);
      const busy = await Appointment.exists({
        clinicId: req.tid,
        doctorId: a.doctorId,
        localDate: a.localDate,
        status: "In Consultation",
        _id: { $ne: a._id },
      }).session(session);
      if (busy) fail(409, "Finish the current consultation first");
      const c =
        existing ||
        (
          await Consultation.create(
            [
              {
                clinicId: req.tid,
                patientId: a.patientId,
                doctorId: a.doctorId,
                appointmentId: a._id,
              },
            ],
            { session },
          )
        )[0];
      a.status = "In Consultation";
      a.calledAt ||= new Date();
      await a.save({ session });
      await audit(
        req,
        "consultation.started",
        "Consultation",
        c._id,
        {},
        "",
        session,
      );
      return c;
    }),
  );
});
clinic.patch("/consultations/:id", prescriber, async (req, res) => {
  const data = parse("consultation", req.body);
  res.json(
    await transaction(async (session) => {
      const c = await get(Consultation, req, req.params.id, session);
      ownDoctor(req, c.doctorId);
      if (c.status !== "draft")
        fail(409, "Signed records require a justified amendment");
      c.set(data);
      await c.save({ session });
      await audit(
        req,
        "consultation.draft.saved",
        "Consultation",
        c._id,
        {},
        "",
        session,
      );
      return c;
    }),
  );
});
clinic.post("/consultations/:id/sign", prescriber, async (req, res) => {
  res.json(
    await transaction(async (session) => {
      const c = await get(Consultation, req, req.params.id, session);
      ownDoctor(req, c.doctorId);
      if (c.status === "signed") return c;
      if (!c.complaint?.trim() || !c.diagnosis?.trim())
        fail(400, "Enter complaint and diagnosis before signing");
      c.status = "signed";
      c.signedBy = req.user._id;
      c.signedAt = new Date();
      const snap = snapshot(c);
      c.signatureHash = hash(snap);
      c.versions.push({
        snapshot: snap,
        authorId: req.user._id,
        at: new Date(),
        hash: c.signatureHash,
        reason: "Initial signature",
      });
      await c.save({ session });
      await Appointment.updateOne(
        { _id: c.appointmentId, clinicId: req.tid },
        { $set: { status: "Completed", completedAt: new Date() } },
        { session },
      );
      await audit(
        req,
        "consultation.signed",
        "Consultation",
        c._id,
        { hash: c.signatureHash },
        "",
        session,
      );
      return c;
    }),
  );
});
clinic.post("/consultations/:id/amend", prescriber, async (req, res) => {
  const why = reason(req.body);
  const data = parse("consultation", req.body.data);
  res.json(
    await transaction(async (session) => {
      const c = await get(Consultation, req, req.params.id, session);
      ownDoctor(req, c.doctorId);
      if (c.status !== "signed") fail(409, "Save draft normally");
      c.set(data);
      c.signedAt = new Date();
      c.signedBy = req.user._id;
      const snap = snapshot(c);
      c.signatureHash = hash(snap);
      c.versions.push({
        snapshot: snap,
        reason: why,
        authorId: req.user._id,
        at: new Date(),
        hash: c.signatureHash,
      });
      await c.save({ session });
      await audit(
        req,
        "consultation.amended",
        "Consultation",
        c._id,
        { hash: c.signatureHash },
        why,
        session,
      );
      return c;
    }),
  );
});
clinic.get("/prescriptions", medical, async (req, res) => {
  const q = {};
  if (req.user.role === "doctor") q.doctorId = req.user.doctorId;
  res.json(await list(Prescription, req, q));
});
clinic.get("/prescriptions/:id", medical, async (req, res) => {
  const p = await get(Prescription, req, req.params.id);
  await patientAccess(req, String(p.patientId));
  await audit(req, "prescription.viewed", "Prescription", p._id);
  res.json(p);
});
clinic.put("/consultations/:id/prescription", prescriber, async (req, res) => {
  const data = parse("prescription", req.body);
  res.json(
    await transaction(async (session) => {
      const c = await get(Consultation, req, req.params.id, session);
      ownDoctor(req, c.doctorId);
      let p = await Prescription.findOne({
        clinicId: req.tid,
        consultationId: c._id,
      }).session(session);
      if (p && p.status !== "draft")
        fail(409, "Signed prescription requires amendment");
      if (!p)
        p = new Prescription({
          clinicId: req.tid,
          patientId: c.patientId,
          doctorId: c.doctorId,
          consultationId: c._id,
        });
      p.set(data);
      await p.save({ session });
      await audit(
        req,
        "prescription.draft.saved",
        "Prescription",
        p._id,
        {},
        "",
        session,
      );
      return p;
    }),
  );
});
clinic.post("/prescriptions/:id/sign", prescriber, async (req, res) => {
  res.json(
    await transaction(async (session) => {
      const p = await get(Prescription, req, req.params.id, session);
      ownDoctor(req, p.doctorId);
      if (p.status === "signed") return p;
      if (p.status === "cancelled") fail(409, "Prescription is cancelled");
      const c = await get(Consultation, req, String(p.consultationId), session);
      if (c.status !== "signed") fail(409, "Sign the consultation first");
      if (
        !p.medicines.length ||
        p.medicines.some(
          (m) => !m.dose?.trim() || !m.frequency?.trim() || !m.duration?.trim(),
        )
      )
        fail(
          400,
          "Doctor must enter dose, frequency and duration for each medicine",
        );
      p.status = "signed";
      p.signedAt = new Date();
      p.signedBy = req.user._id;
      const snap = snapshot(p);
      p.signatureHash = hash(snap);
      p.versions.push({
        snapshot: snap,
        reason: "Initial signature",
        authorId: req.user._id,
        at: new Date(),
        hash: p.signatureHash,
      });
      await p.save({ session });
      await audit(
        req,
        "prescription.signed",
        "Prescription",
        p._id,
        { hash: p.signatureHash },
        "",
        session,
      );
      return p;
    }),
  );
});
clinic.post("/prescriptions/:id/amend", prescriber, async (req, res) => {
  const why = reason(req.body),
    data = parse("prescription", req.body.data);
  res.json(
    await transaction(async (session) => {
      const p = await get(Prescription, req, req.params.id, session);
      ownDoctor(req, p.doctorId);
      if (p.status !== "signed")
        fail(409, "Only signed prescriptions may be amended");
      if (
        data.medicines.some(
          (m) => !m.dose?.trim() || !m.frequency?.trim() || !m.duration?.trim(),
        )
      )
        fail(400, "Doctor must enter dose, frequency and duration");
      p.set(data);
      p.signedAt = new Date();
      p.signedBy = req.user._id;
      const snap = snapshot(p);
      p.signatureHash = hash(snap);
      p.versions.push({
        snapshot: snap,
        reason: why,
        authorId: req.user._id,
        at: new Date(),
        hash: p.signatureHash,
      });
      await p.save({ session });
      await audit(
        req,
        "prescription.amended",
        "Prescription",
        p._id,
        { hash: p.signatureHash },
        why,
        session,
      );
      return p;
    }),
  );
});
clinic.post("/prescriptions/:id/cancel", prescriber, async (req, res) => {
  const why = reason(req.body);
  res.json(
    await transaction(async (session) => {
      const p = await get(Prescription, req, req.params.id, session);
      ownDoctor(req, p.doctorId);
      p.status = "cancelled";
      p.versions.push({
        snapshot: snapshot(p),
        reason: why,
        authorId: req.user._id,
        at: new Date(),
        hash: hash(snapshot(p)),
      });
      await p.save({ session });
      await audit(
        req,
        "prescription.cancelled",
        "Prescription",
        p._id,
        {},
        why,
        session,
      );
      return p;
    }),
  );
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});
function magic(buffer) {
  if (buffer.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  fail(400, "Only genuine PDF, JPEG and PNG documents are accepted");
}
clinic.post(
  "/patients/:id/documents",
  medical,
  upload.single("file"),
  async (req, res) => {
    await patientAccess(req, req.params.id);
    await get(Patient, req, req.params.id);
    if (!req.file) fail(400, "Choose a document");
    const mime = magic(req.file.buffer);
    const filename = crypto.randomUUID();
    await fs.mkdir(env.uploads, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(env.uploads, filename), req.file.buffer, {
      mode: 0o600,
    });
    try {
      const d = await Document.create({
        clinicId: req.tid,
        patientId: req.params.id,
        title: String(req.body.title || req.file.originalname).slice(0, 200),
        filename,
        originalName: req.file.originalname.slice(0, 200),
        mime,
        size: req.file.size,
        authorId: req.user._id,
      });
      await audit(req, "document.uploaded", "Document", d._id);
      res.status(201).json(d);
    } catch (e) {
      await fs.unlink(path.join(env.uploads, filename));
      throw e;
    }
  },
);
clinic.get("/documents/:id/download", medical, async (req, res) => {
  const d = await get(Document, req, req.params.id);
  await patientAccess(req, String(d.patientId));
  await audit(req, "document.downloaded", "Document", d._id);
  res.set("Content-Type", d.mime);
  res.download(path.resolve(env.uploads, d.filename), d.originalName);
});
clinic.post(
  "/settings/logo",
  permit("settings:write"),
  upload.single("file"),
  async (req, res) => {
    if (!req.file) fail(400, "Choose an image");
    const mime = magic(req.file.buffer);
    if (mime === "application/pdf" || req.file.size > 1024 * 1024)
      fail(400, "Logo must be PNG or JPEG, under 1 MB");
    req.clinic.logo = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
    await req.clinic.save();
    await audit(req, "clinic.logo.updated", "Clinic", req.tid);
    res.json(req.clinic);
  },
);
clinic.get("/settings", async (req, res) => {
  if (!req.tid) fail(403, "Clinic account required");
  res.json(req.clinic);
});
clinic.put("/settings", permit("settings:write"), async (req, res) => {
  const data = parse("settings", req.body);
  const result = await transaction(async (session) => {
    const c = await Clinic.findById(req.tid).session(session);
    c.set(data);
    await c.save({ session });
    await audit(
      req,
      "clinic.settings.updated",
      "Clinic",
      req.tid,
      {},
      "",
      session,
    );
    return c;
  });
  res.json(result);
});
clinic.get("/users", permit("users:write"), async (req, res) =>
  res.json(
    await User.find({ clinicId: req.tid }).select("-passwordHash").lean(),
  ),
);
clinic.post("/users", permit("users:write"), async (req, res) => {
  const data = parse("user", req.body);
  if (
    req.user.role !== "owner" &&
    (data.role === "owner" || data.clinicalAccess || data.permissions?.length)
  )
    fail(403, "Only an owner may grant privileged access");
  if (data.role === "doctor" && !data.doctorId)
    fail(400, "Link doctor account to a doctor");
  if (data.clinicalAccess && req.user.role !== "owner")
    fail(403, "Owner approval required");
  res.status(201).json(
    await transaction(async (session) => {
      await serial(req.tid, "user-limit", session);
      if (
        (await User.countDocuments({ clinicId: req.tid, active: true }).session(
          session,
        )) >= req.clinic.userLimit
      )
        fail(409, "Subscription staff limit reached");
      if (data.doctorId) await get(Doctor, req, data.doctorId, session);
      const { password, ...fields } = data;
      const [u] = await User.create(
        [
          {
            clinicId: req.tid,
            ...fields,
            passwordHash: await bcrypt.hash(password, 12),
          },
        ],
        { session },
      );
      await audit(
        req,
        "user.created",
        "User",
        u._id,
        { role: u.role },
        "",
        session,
      );
      return { _id: u._id, name: u.name, email: u.email, role: u.role };
    }),
  );
});
clinic.patch("/users/:id", permit("users:write"), async (req, res) => {
  const data = z
    .object({
      active: z.boolean(),
      clinicalAccess: z.boolean().optional(),
      permissions: z.array(z.string().max(50)).max(20).optional(),
    })
    .strict()
    .parse(req.body);
  res.json(
    await transaction(async (session) => {
      const u = await User.findOne({
        _id: id(req.params.id),
        clinicId: req.tid,
      }).session(session);
      if (!u) fail(404, "User not found");
      if (String(u._id) === String(req.user._id) && !data.active)
        fail(409, "Cannot disable your own account");
      if (u.role === "owner" && req.user.role !== "owner")
        fail(403, "Owner access restricted");
      if (
        (data.clinicalAccess !== undefined || data.permissions !== undefined) &&
        req.user.role !== "owner"
      )
        fail(403, "Only owner may change access permissions");
      if (
        !data.active &&
        u.role === "owner" &&
        (await User.countDocuments({
          clinicId: req.tid,
          role: "owner",
          active: true,
        }).session(session)) <= 1
      )
        fail(409, "Keep at least one active owner");
      if (data.active && !u.active) {
        await serial(req.tid, "user-limit", session);
        if (
          (await User.countDocuments({
            clinicId: req.tid,
            active: true,
          }).session(session)) >= req.clinic.userLimit
        )
          fail(409, "Subscription user limit reached");
      }
      u.set(data);
      await u.save({ session });
      await Refresh.updateMany(
        { userId: u._id },
        { $set: { revokedAt: new Date() } },
        { session },
      );
      await audit(req, "user.access.updated", "User", u._id, data, "", session);
      return u;
    }),
  );
});
clinic.post("/users/:id/reset", permit("users:write"), async (req, res) => {
  const password = z.string().min(12).max(128).parse(req.body.password);
  const u = await User.findOne({ _id: id(req.params.id), clinicId: req.tid });
  if (!u) fail(404, "User not found");
  if (u.role === "owner" && req.user.role !== "owner")
    fail(403, "Owner access restricted");
  u.passwordHash = await bcrypt.hash(password, 12);
  u.mustChangePassword = true;
  u.authVersion = (u.authVersion || 0) + 1;
  await u.save();
  await Refresh.updateMany(
    { userId: u._id },
    { $set: { revokedAt: new Date() } },
  );
  await audit(req, "user.password.reset", "User", u._id);
  res.json({ ok: true });
});
clinic.get("/audit", permit("audit:read"), async (req, res) => {
  const { p, size, skip } = page(req);
  const q = { clinicId: req.tid };
  const projection = clinical(req) ? "" : "-changes";
  res.json({
    items: await Audit.find(q)
      .select(projection)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(size),
    total: await Audit.countDocuments(q),
    page: p,
    limit: size,
  });
});
clinic.get("/support-grants", permit("settings:write"), async (req, res) =>
  res.json(
    await SupportGrant.find({ clinicId: req.tid })
      .sort({ createdAt: -1 })
      .limit(50),
  ),
);
clinic.post("/support-grants", permit("settings:write"), async (req, res) => {
  const why = reason(req.body);
  const admin = await User.findOne({
    _id: id(req.body.adminId),
    role: "superadmin",
    active: true,
  });
  if (!admin) fail(400, "Administrator not found");
  const minutes = z.number().int().min(5).max(120).parse(req.body.minutes);
  const g = await SupportGrant.create({
    clinicId: req.tid,
    approvedBy: req.user._id,
    adminId: admin._id,
    reason: why,
    expiresAt: new Date(Date.now() + minutes * 60000),
  });
  await audit(req, "support.approved", "SupportGrant", g._id, {}, why);
  res.status(201).json(g);
});
clinic.post(
  "/support-grants/:id/revoke",
  permit("settings:write"),
  async (req, res) => {
    const g = await get(SupportGrant, req, req.params.id);
    g.revokedAt = new Date();
    await g.save();
    await audit(req, "support.revoked", "SupportGrant", g._id);
    res.json(g);
  },
);

clinic.get(
  "/appointments/:id",
  permit("appointments:read"),
  async (req, res) => {
    const a = await get(Appointment, req, req.params.id);
    ownDoctor(req, a.doctorId);
    const d = await get(Doctor, req, String(a.doctorId));
    res.json({ ...a.toObject(), doctorName: d.name });
  },
);
clinic.get("/support-admins", permit("settings:write"), async (req, res) =>
  res.json(
    await User.find({ role: "superadmin", active: true }).select("name email"),
  ),
);
clinic.post(
  "/expenses/:id/receipt",
  permit("finance:write"),
  upload.single("file"),
  async (req, res) => {
    const e = await get(Expense, req, req.params.id);
    if (!req.file) fail(400, "Choose a file");
    const mime = magic(req.file.buffer),
      filename = crypto.randomUUID();
    await fs.mkdir(env.uploads, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(env.uploads, filename), req.file.buffer, {
      mode: 0o600,
    });
    try {
      e.receipt = {
        filename,
        originalName: req.file.originalname.slice(0, 200),
        mime,
        size: req.file.size,
      };
      await e.save();
      await audit(req, "expense.receipt.attached", "Expense", e._id);
      res.json(e);
    } catch (err) {
      await fs.unlink(path.join(env.uploads, filename));
      throw err;
    }
  },
);
clinic.get(
  "/expenses/:id/receipt",
  permit("finance:read"),
  async (req, res) => {
    const e = await get(Expense, req, req.params.id);
    if (!e.receipt?.filename) fail(404, "No receipt attached");
    await audit(req, "expense.receipt.downloaded", "Expense", e._id);
    res
      .type(e.receipt.mime)
      .download(
        path.resolve(env.uploads, e.receipt.filename),
        e.receipt.originalName,
      );
  },
);

clinic.post(
  "/doctors/:id/photo",
  permit("doctors:write"),
  upload.single("file"),
  async (req, res) => {
    const d = await get(Doctor, req, req.params.id);
    if (!req.file) fail(400, "Choose a photo");
    const mime = magic(req.file.buffer);
    if (mime === "application/pdf" || req.file.size > 1024 * 1024)
      fail(400, "Photo must be JPEG or PNG, under 1 MB");
    d.photo = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
    await d.save();
    await audit(req, "doctor.photo.updated", "Doctor", d._id);
    res.json(d);
  },
);
