import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import request from "supertest";
import ExcelJS from "exceljs";
import { MongoMemoryReplSet } from "mongodb-memory-server";
process.env.JWT_SECRET = "clinic-test-secret-at-least-thirty-two-characters";
process.env.LOG_REQUESTS = "false";
process.env.UPLOAD_DIR = "/tmp/clinic-test-uploads";
const { app } = await import("../src/app.js");
const M = await import("../src/models/index.js");
const { localDate } = await import("../src/utils/domain.js");
let repl,
  tidA,
  tidB,
  doctorA,
  doctorB,
  patientA,
  patientB,
  owner,
  doctor,
  reception,
  accountant,
  superadmin,
  ownerB,
  consultation,
  rx,
  invoice,
  appointment;
async function call(token, method, path, body, status = 200) {
  const r = await request(app)
    [method]("/api" + path)
    .set("Authorization", "Bearer " + token)
    .send(body);
  assert.equal(
    r.status,
    status,
    `${method} ${path}: ${JSON.stringify(r.body)}`,
  );
  return r.body;
}
async function login(email) {
  const r = await request(app)
    .post("/api/auth/login")
    .send({ email, password: "TestPassword123!" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.accessToken;
}
before(async () => {
  repl = await MongoMemoryReplSet.create({
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
  await mongoose.connect(repl.getUri());
  for (const model of M.allModels) await model.createIndexes();
  const a = await M.Clinic.create({
    name: "Test Clinic A",
    expiresAt: new Date(Date.now() + 86400000),
    doctorLimit: 10,
    userLimit: 20,
  });
  const b = await M.Clinic.create({
    name: "Test Clinic B",
    expiresAt: new Date(Date.now() + 86400000),
  });
  tidA = a._id;
  tidB = b._id;
  const makeDoctor = (clinicId) =>
    M.Doctor.create({
      clinicId,
      name: "Test Doctor",
      fee: 100000,
      followupFee: 50000,
      duration: 15,
      sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
    });
  doctorA = await makeDoctor(tidA);
  doctorB = await makeDoctor(tidB);
  const passwordHash = await bcrypt.hash("TestPassword123!", 4);
  await M.User.insertMany([
    {
      clinicId: tidA,
      email: "owner@test.com",
      name: "Owner",
      role: "owner",
      passwordHash,
      mustChangePassword: false,
    },
    {
      clinicId: tidA,
      email: "doctor@test.com",
      name: "Doctor",
      role: "doctor",
      doctorId: doctorA._id,
      passwordHash,
      mustChangePassword: false,
    },
    {
      clinicId: tidA,
      email: "reception@test.com",
      name: "Reception",
      role: "receptionist",
      passwordHash,
      mustChangePassword: false,
    },
    {
      clinicId: tidA,
      email: "accounts@test.com",
      name: "Accountant",
      role: "accountant",
      passwordHash,
      mustChangePassword: false,
    },
    {
      clinicId: tidB,
      email: "ownerb@test.com",
      name: "Owner B",
      role: "owner",
      passwordHash,
      mustChangePassword: false,
    },
    {
      email: "admin@test.com",
      name: "Admin",
      role: "superadmin",
      passwordHash,
      mustChangePassword: false,
    },
  ]);
  owner = await login("owner@test.com");
  doctor = await login("doctor@test.com");
  reception = await login("reception@test.com");
  accountant = await login("accounts@test.com");
  superadmin = await login("admin@test.com");
  ownerB = await login("ownerb@test.com");
  patientA = await M.Patient.create({
    clinicId: tidA,
    mrn: "P-ROOT",
    name: "Patient A",
    gender: "Male",
    mobile: "03001234567",
    allergies: "CONFIDENTIAL",
    medicalHistory: "SECRET HISTORY",
  });
  patientB = await M.Patient.create({
    clinicId: tidB,
    mrn: "P-B",
    name: "Patient B",
    gender: "Female",
    allergies: "TENANT B SECRET",
  });
});
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});
test("Tenant isolation and clinical redaction are enforced by backend APIs", async () => {
  await call(owner, "get", `/patients/${patientB._id}`, undefined, 404);
  await call(superadmin, "get", `/patients/${patientA._id}`, undefined, 403);
  await call(reception, "get", "/consultations", undefined, 403);
  await call(accountant, "get", "/prescriptions", undefined, 403);
  const p = await call(reception, "get", `/patients/${patientA._id}`);
  assert.equal(p.allergies, undefined);
  assert.equal(p.medicalHistory, undefined);
  const changed = await call(reception, "patch", `/patients/${patientA._id}`, {
    name: "Patient A Updated",
    gender: "Male",
    mobile: "03001234567",
    allergies: "ATTEMPTED OVERWRITE",
  });
  assert.equal(changed.allergies, undefined);
  assert.equal(
    (await M.Patient.findById(patientA._id)).allergies,
    "CONFIDENTIAL",
  );
  await call(
    owner,
    "post",
    "/patients",
    { name: "Injection", gender: "Male", clinicId: String(tidB) },
    400,
  );
  await call(
    owner,
    "post",
    `/patients/${patientA._id}/archive`,
    { reason: "Archive request" },
    409,
  );
});
test("Concurrent patient registration generates unique MRNs", async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      request(app)
        .post("/api/patients")
        .set("Authorization", "Bearer " + reception)
        .send({ name: `Concurrent Patient ${i}`, gender: "Unspecified" }),
    ),
  );
  assert.ok(
    results.every((r) => r.status === 201),
    JSON.stringify(results.map((r) => r.body)),
  );
  assert.equal(new Set(results.map((r) => r.body.mrn)).size, 6);
  const matches = await call(
    reception,
    "get",
    "/patients/matches?mobile=03001234567",
  );
  assert.equal(matches.length, 1);
});
test("Scheduling prevents overlap, blocked sessions and cross-clinic references", async () => {
  const start = new Date();
  start.setUTCHours(7, 0, 0, 0);
  const data = {
    patientId: String(patientA._id),
    doctorId: String(doctorA._id),
    startAt: start.toISOString(),
    type: "Consultation",
  };
  const responses = await Promise.all([
    request(app)
      .post("/api/appointments")
      .set("Authorization", "Bearer " + owner)
      .send(data),
    request(app)
      .post("/api/appointments")
      .set("Authorization", "Bearer " + owner)
      .send(data),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  appointment = responses.find((r) => r.status === 201).body;
  await call(
    owner,
    "post",
    "/appointments",
    {
      ...data,
      patientId: String(patientB._id),
      startAt: new Date(start.getTime() + 3600000).toISOString(),
    },
    404,
  );
  const same = await call(
    owner,
    "post",
    `/appointments/${appointment._id}/check-in`,
  );
  const again = await call(
    owner,
    "post",
    `/appointments/${appointment._id}/check-in`,
  );
  assert.equal(same.token, again.token);
  const a2 = await call(
    owner,
    "post",
    "/appointments",
    { ...data, startAt: new Date(start.getTime() + 30 * 60000).toISOString() },
    201,
  );
  const tokens = await Promise.all([
    request(app)
      .post(`/api/appointments/${a2._id}/check-in`)
      .set("Authorization", "Bearer " + owner),
    request(app)
      .post(`/api/appointments/${appointment._id}/check-in`)
      .set("Authorization", "Bearer " + owner),
  ]);
  assert.ok(tokens.every((r) => r.status === 200));
  assert.equal(new Set(tokens.map((r) => r.body.token)).size, 2);
  const original = doctorA.toObject();
  await M.Doctor.updateOne(
    { _id: doctorA._id },
    { $set: { leaves: [{ date: localDate(start), reason: "Leave" }] } },
  );
  await call(
    owner,
    "post",
    "/appointments",
    { ...data, startAt: new Date(start.getTime() + 60 * 60000).toISOString() },
    409,
  );
  await M.Doctor.updateOne({ _id: doctorA._id }, { $set: { leaves: [] } });
});
test("Signed EMR remains immutable and doctor-approved amendments preserve versions", async () => {
  consultation = await call(doctor, "post", "/consultations/start", {
    appointmentId: appointment._id,
  });
  await call(
    reception,
    "patch",
    `/consultations/${consultation._id}`,
    { diagnosis: "Forbidden" },
    403,
  );
  await call(
    doctor,
    "post",
    `/consultations/${consultation._id}/sign`,
    undefined,
    400,
  );
  await call(doctor, "patch", `/consultations/${consultation._id}`, {
    complaint: "Test complaint",
    diagnosis: "Test diagnosis",
    vitals: { heartRate: 70, spo2: 99 },
  });
  consultation = await call(
    doctor,
    "post",
    `/consultations/${consultation._id}/sign`,
  );
  assert.equal(consultation.versions.length, 1);
  assert.equal(consultation.status, "signed");
  assert.ok(consultation.signatureHash);
  await call(
    doctor,
    "patch",
    `/consultations/${consultation._id}`,
    { diagnosis: "Silent overwrite" },
    409,
  );
  const amended = await call(
    doctor,
    "post",
    `/consultations/${consultation._id}/amend`,
    {
      reason: "Correction of note",
      data: { diagnosis: "Corrected test diagnosis" },
    },
  );
  assert.equal(amended.versions.length, 2);
  assert.equal(amended.versions[0].snapshot.diagnosis, "Test diagnosis");
  assert.equal(
    amended.versions[1].snapshot.diagnosis,
    "Corrected test diagnosis",
  );
  const db = await M.Appointment.findById(appointment._id);
  assert.equal(db.status, "Completed");
  await call(
    owner,
    "get",
    `/consultations/${consultation._id}`,
    undefined,
    403,
  );
});
test("Prescription approval requires manually entered instructions and signed encounter", async () => {
  const base = {
    medicines: [{ name: "Test medicine", strength: "Test strength" }],
  };
  rx = await call(
    doctor,
    "put",
    `/consultations/${consultation._id}/prescription`,
    base,
  );
  await call(doctor, "post", `/prescriptions/${rx._id}/sign`, undefined, 400);
  await call(
    reception,
    "post",
    `/prescriptions/${rx._id}/sign`,
    undefined,
    403,
  );
  rx = await call(
    doctor,
    "put",
    `/consultations/${consultation._id}/prescription`,
    {
      medicines: [
        {
          name: "Test medicine",
          dose: "Manually entered dose",
          frequency: "Doctor selected frequency",
          duration: "Doctor selected duration",
        },
      ],
    },
  );
  rx = await call(doctor, "post", `/prescriptions/${rx._id}/sign`);
  assert.equal(rx.status, "signed");
  await call(
    doctor,
    "put",
    `/consultations/${consultation._id}/prescription`,
    base,
    409,
  );
  await call(
    doctor,
    "post",
    `/prescriptions/${rx._id}/amend`,
    { reason: "Corrected instructions", data: base },
    400,
  );
  await call(doctor, "post", `/prescriptions/${rx._id}/cancel`, {
    reason: "Prescription correction",
  });
  assert.equal((await M.Prescription.findById(rx._id)).versions.length, 2);
});
test("Invoice calculations use integer minor units and reject duplicate encounter charges", async () => {
  const payload = {
    patientId: String(patientA._id),
    doctorId: String(doctorA._id),
    consultationId: consultation._id,
    services: [{ name: "Consultation", quantity: 1, unitPrice: 100001 }],
    discount: 1001,
    taxBasisPoints: 1000,
  };
  invoice = await call(owner, "post", "/invoices", payload, 201);
  assert.equal(invoice.subtotal, 100001);
  assert.equal(invoice.tax, 9900);
  assert.equal(invoice.total, 108900);
  assert.equal(invoice.balance, 108900);
  const posting = await M.Journal.findOne({
    sourceId: invoice._id,
    event: "invoice",
  });
  assert.equal(posting.revenue, 99000);
  assert.equal(posting.taxLiability, 9900);
  await call(owner, "post", "/invoices", payload, 409);
  await call(
    owner,
    "post",
    "/invoices",
    { ...payload, consultationId: undefined, patientId: String(patientB._id) },
    404,
  );
  await call(doctor, "post", "/invoices", payload, 403);
});
test("Payments are idempotent under concurrency and do not overcollect", async () => {
  const data = {
    amount: 50000,
    method: "Cash",
    account: "cash",
    key: "same-idempotency-key",
  };
  const responses = await Promise.all([
    request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set("Authorization", "Bearer " + reception)
      .send(data),
    request(app)
      .post(`/api/invoices/${invoice._id}/payments`)
      .set("Authorization", "Bearer " + reception)
      .send(data),
  ]);
  assert.ok(
    responses.every((r) => r.status === 201),
    JSON.stringify(responses.map((r) => r.body)),
  );
  assert.equal(new Set(responses.map((r) => r.body._id)).size, 1);
  assert.equal(await M.Payment.countDocuments({ invoiceId: invoice._id }), 1);
  await call(
    owner,
    "post",
    `/invoices/${invoice._id}/payments`,
    { ...data, amount: 50001 },
    409,
  );
  await call(
    owner,
    "post",
    `/invoices/${invoice._id}/payments`,
    { ...data, key: "excess-payment-key", amount: 999999 },
    400,
  );
  const receipt = await call(owner, "get", `/invoices/${invoice._id}`);
  assert.equal(receipt.balance, 58900);
  assert.equal(receipt.paymentStatus, "Partial");
});
test("Refunds, expense reversals and invoice voids reconcile cash and journal revenue", async () => {
  const refund = {
    amount: 50000,
    method: "Cash",
    account: "cash",
    key: "refund-idempotency-key",
    reason: "Refund for test transaction",
  };
  await call(
    reception,
    "post",
    `/invoices/${invoice._id}/refunds`,
    refund,
    403,
  );
  await call(
    accountant,
    "post",
    `/invoices/${invoice._id}/refunds`,
    refund,
    201,
  );
  await call(
    accountant,
    "post",
    `/invoices/${invoice._id}/refunds`,
    { ...refund, key: "over-refund-test" },
    400,
  );
  const e = await call(
    accountant,
    "post",
    "/expenses",
    {
      description: "Test expense",
      category: "Cleaning",
      amount: 2500,
      account: "cash",
      method: "Cash",
      date: localDate(new Date()),
    },
    201,
  );
  await call(accountant, "post", `/expenses/${e._id}/post`);
  await call(
    accountant,
    "patch",
    `/expenses/${e._id}`,
    {
      description: "Rewrite",
      category: "Cleaning",
      amount: 3000,
      account: "cash",
      method: "Cash",
      date: localDate(new Date()),
    },
    409,
  );
  await call(accountant, "post", `/expenses/${e._id}/reverse`, {
    reason: "Reverse test expense",
  });
  await call(accountant, "post", `/expenses/${e._id}/reverse`, {
    reason: "Repeated reversal",
  });
  await call(accountant, "post", `/invoices/${invoice._id}/void`, {
    reason: "Reverse test invoice",
  });
  const entries = await M.Journal.find({ clinicId: tidA }).lean();
  for (const key of [
    "cash",
    "bank",
    "revenue",
    "expenses",
    "receivable",
    "taxLiability",
  ])
    assert.equal(
      entries.reduce((s, e) => s + e[key], 0),
      0,
      key,
    );
  const inv = await call(accountant, "get", `/invoices/${invoice._id}`);
  assert.equal(inv.balance, 0);
  assert.equal(inv.status, "void");
  const report = await call(
    accountant,
    "get",
    `/reports/profit-loss?from=${localDate(new Date())}&to=${localDate(new Date())}`,
  );
  assert.equal(report.metrics.NetOperatingResult, 0);
});
test("Report exports restrict roles and produce genuine Excel files", async () => {
  await call(doctor, "get", `/reports/profit-loss`, undefined, 403);
  await call(reception, "get", `/reports/patients`, undefined, 403);
  const r = await request(app)
    .get("/api/reports/cash-ledger/export?format=xlsx")
    .set("Authorization", "Bearer " + accountant)
    .buffer(true)
    .parse((res, done) => {
      const parts = [];
      res.on("data", (x) => parts.push(x));
      res.on("end", () => done(null, Buffer.concat(parts)));
    });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /spreadsheetml/);
  const body = r.body;
  assert.ok(body.length > 1000);
  assert.equal(body.subarray(0, 2).toString(), "PK");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(body);
  assert.ok(book.worksheets[0].rowCount > 6);
  const db = await call(superadmin, "get", "/admin/dashboard");
  assert.equal(db.clinics, 2);
  await call(superadmin, "get", `/admin/support/${tidA}`, undefined, 403);
  const adminUser = await M.User.findOne({ role: "superadmin" });
  const grant = await call(
    owner,
    "post",
    "/support-grants",
    {
      adminId: String(adminUser._id),
      minutes: 5,
      reason: "Investigate configuration",
    },
    201,
  );
  const support = await call(superadmin, "get", `/admin/support/${tidA}`);
  assert.ok(!("patients" in support));
  await call(owner, "post", `/support-grants/${grant._id}/revoke`);
  await call(superadmin, "get", `/admin/support/${tidA}`, undefined, 403);
});
test("Document upload checks actual file signatures and medical access", async () => {
  let r = await request(app)
    .post(`/api/patients/${patientA._id}/documents`)
    .set("Authorization", "Bearer " + doctor)
    .attach("file", Buffer.from("not a pdf"), {
      filename: "pretend.pdf",
      contentType: "application/pdf",
    });
  assert.equal(r.status, 400);
  r = await request(app)
    .post(`/api/patients/${patientA._id}/documents`)
    .set("Authorization", "Bearer " + doctor)
    .attach("file", Buffer.from("%PDF-1.4\nTest synthetic document\n%%EOF"), {
      filename: "test.pdf",
      contentType: "application/pdf",
    });
  assert.equal(r.status, 201);
  await call(
    reception,
    "get",
    `/documents/${r.body._id}/download`,
    undefined,
    403,
  );
  await call(
    ownerB,
    "get",
    `/documents/${r.body._id}/download`,
    undefined,
    403,
  );
});
test("Refresh rotation detects replay; temporary passwords can be changed", async () => {
  const loginR = await request(app)
    .post("/api/auth/login")
    .send({ email: "owner@test.com", password: "TestPassword123!" });
  const cookie = loginR.headers["set-cookie"][0].split(";")[0];
  const r = await request(app).post("/api/auth/refresh").set("Cookie", cookie);
  assert.equal(r.status, 200);
  const nextCookie = r.headers["set-cookie"][0].split(";")[0];
  const replay = await request(app)
    .post("/api/auth/refresh")
    .set("Cookie", cookie);
  assert.equal(replay.status, 401);
  assert.equal(
    (await request(app).post("/api/auth/refresh").set("Cookie", nextCookie))
      .status,
    401,
  );
  const u = await call(
    owner,
    "post",
    "/users",
    {
      name: "Temporary user",
      email: "temp@test.com",
      password: "TestPassword123!",
      role: "receptionist",
    },
    201,
  );
  const token = await login("temp@test.com");
  await call(token, "get", "/patients", undefined, 403);
  const changed = await call(token, "post", "/auth/password", {
    currentPassword: "TestPassword123!",
    password: "NewSecurePassword123!",
  });
  await call(changed.accessToken, "get", "/patients");
  await call(token, "get", "/patients", undefined, 401);
  await M.Clinic.updateOne({ _id: tidB }, { $set: { status: "suspended" } });
  await call(ownerB, "get", "/patients", undefined, 403);
});
