import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { pathToFileURL } from "node:url";
import { env } from "./config/env.js";
import {
  Clinic,
  User,
  Doctor,
  Patient,
  Appointment,
  Invoice,
  Payment,
  Expense,
  Journal,
  Plan,
  Counter,
  allModels,
} from "./models/index.js";
import { localDate } from "./utils/domain.js";
export async function bootstrap({ demo = false } = {}) {
  const email = process.env.ADMIN_EMAIL,
    password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error(
      "Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) before bootstrap",
    );
  const passwordHash = await bcrypt.hash(password, 12);
  if (!(await User.exists({ role: "superadmin" })))
    await User.create({
      name: "Ahmed Solutions Admin",
      email,
      passwordHash,
      role: "superadmin",
      mustChangePassword: false,
    });
  if (!(await Plan.countDocuments()))
    await Plan.insertMany([
      { name: "Monthly", months: 1, doctorLimit: 3, userLimit: 10, price: 0 },
      { name: "Quarterly", months: 3, doctorLimit: 5, userLimit: 15, price: 0 },
      { name: "Yearly", months: 12, doctorLimit: 10, userLimit: 25, price: 0 },
      { name: "Custom", months: 1, doctorLimit: 2, userLimit: 5, price: 0 },
    ]);
  if (!demo) return;
  if (env.production) throw new Error("Demo seed is disabled in production");
  if (await Clinic.exists({ email: "owner@demo.clinic" })) return;
  const clinic = await Clinic.create({
    name: "Sehat Family Clinic · Demo",
    ownerName: "Demo Owner",
    email: "owner@demo.clinic",
    address: "University Road, Peshawar",
    city: "Peshawar",
    phone: "091-0000000",
    expiresAt: new Date(Date.now() + 365 * 86400000),
    doctorLimit: 5,
    userLimit: 15,
    subscriptionStart: new Date(),
    settings: {
      invoiceFooter: "Thank you. Keep this invoice for your records.",
      prescriptionFooter:
        "Synthetic demonstration clinic. Not a medical prescription.",
      tokenPrefix: "T",
      invoicePrefix: "INV",
    },
  });
  const clinicId = clinic._id,
    pass = await bcrypt.hash("ClinicDemo123!", 10);
  const docs = await Doctor.insertMany([
    {
      clinicId,
      name: "Dr. Ayesha · Demo",
      specialization: "General Practitioner",
      qualification: "MBBS",
      registration: "DEMO-001",
      fee: 150000,
      followupFee: 100000,
      duration: 15,
      sessions: [
        { days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "13:00" },
        { days: [0, 1, 2, 3, 4, 5, 6], start: "14:00", end: "23:45" },
      ],
    },
    {
      clinicId,
      name: "Dr. Hamza · Demo",
      specialization: "Family Medicine",
      qualification: "MBBS",
      registration: "DEMO-002",
      fee: 200000,
      followupFee: 120000,
      duration: 20,
      sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "23:45" }],
    },
  ]);
  await User.insertMany([
    {
      clinicId,
      name: "Demo Owner",
      email: "owner@demo.clinic",
      passwordHash: pass,
      role: "owner",
      mustChangePassword: false,
    },
    {
      clinicId,
      name: "Demo Doctor",
      email: "doctor@demo.clinic",
      passwordHash: pass,
      role: "doctor",
      doctorId: docs[0]._id,
      mustChangePassword: false,
    },
    {
      clinicId,
      name: "Demo Reception",
      email: "reception@demo.clinic",
      passwordHash: pass,
      role: "receptionist",
      mustChangePassword: false,
    },
    {
      clinicId,
      name: "Demo Accountant",
      email: "accounts@demo.clinic",
      passwordHash: pass,
      role: "accountant",
      mustChangePassword: false,
    },
  ]);
  const patients = await Patient.insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      clinicId,
      mrn: `P-${String(i + 1).padStart(6, "0")}`,
      name: `Demo Patient ${String(i + 1).padStart(2, "0")}`,
      age: 20 + i * 3,
      gender: i % 2 ? "Female" : "Male",
      mobile: `03000000${String(i + 1).padStart(3, "0")}`,
      city: "Peshawar",
      allergies: "Synthetic demo record; confirm during consultation",
    })),
  );
  let tokens = 0;
  for (let day = 6; day >= 0; day--) {
    for (let j = 0; j < (day === 0 ? 9 : 4 + (day % 3)); j++) {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - day);
      start.setUTCHours(4 + Math.floor(j / 4), (j % 4) * 15, 0, 0);
      const doctor = docs[j % 2],
        patient = patients[(j + day) % patients.length];
      const status = day
        ? "Completed"
        : j < 3
          ? "Completed"
          : j < 6
            ? "Waiting"
            : "Scheduled";
      const checked =
        day === 0 && j < 6 ? new Date(start.getTime() - 10 * 60000) : undefined;
      const token =
        day === 0 && j < 6
          ? `T-${String(++tokens).padStart(3, "0")}`
          : undefined;
      const a = await Appointment.create({
        clinicId,
        patientId: patient._id,
        doctorId: doctor._id,
        startAt: start,
        endAt: new Date(start.getTime() + 15 * 60000),
        localDate: localDate(start),
        status,
        token,
        queueOrder: tokens,
        checkedInAt: checked,
        calledAt: status === "Completed" ? start : undefined,
        completedAt:
          status === "Completed"
            ? new Date(start.getTime() + 15 * 60000)
            : undefined,
      });
      if (status === "Completed") {
        const n = (await Invoice.countDocuments({ clinicId })) + 1,
          amount = doctor.fee;
        const inv = await Invoice.create({
          clinicId,
          patientId: patient._id,
          doctorId: doctor._id,
          appointmentId: a._id,
          number: `INV-${String(n).padStart(6, "0")}`,
          services: [
            {
              name: "Consultation",
              quantity: 1,
              unitPrice: amount,
              total: amount,
            },
          ],
          subtotal: amount,
          discount: 0,
          tax: 0,
          total: amount,
          paid: j === 0 ? 0 : amount,
          createdAt: start,
          updatedAt: start,
        });
        await Journal.create({
          clinicId,
          event: "invoice",
          sourceId: inv._id,
          key: `invoice:${inv._id}`,
          amount,
          revenue: amount,
          receivable: amount,
          description: inv.number,
          createdAt: start,
          updatedAt: start,
        });
        if (j !== 0) {
          const p = await Payment.create({
            clinicId,
            invoiceId: inv._id,
            patientId: patient._id,
            amount,
            method: "Cash",
            account: "cash",
            kind: "receipt",
            key: `demo-${inv._id}`,
            createdAt: start,
            updatedAt: start,
          });
          await Journal.create({
            clinicId,
            event: "receipt",
            sourceId: p._id,
            key: `payment:${p._id}`,
            amount,
            cash: amount,
            receivable: -amount,
            description: inv.number,
            createdAt: start,
            updatedAt: start,
          });
        }
      }
    }
  }
  const e = await Expense.create({
    clinicId,
    description: "Cleaning supplies · Demo",
    category: "Cleaning",
    amount: 250000,
    method: "Cash",
    account: "cash",
    date: localDate(new Date()),
    status: "posted",
    postedAt: new Date(),
  });
  await Journal.create({
    clinicId,
    event: "expense",
    sourceId: e._id,
    key: `expense:${e._id}`,
    amount: e.amount,
    expenses: e.amount,
    cash: -e.amount,
    description: e.description,
  });
  await Counter.insertMany([
    { clinicId, key: "patient", value: 12 },
    {
      clinicId,
      key: "invoice",
      value: await Invoice.countDocuments({ clinicId }),
    },
    ...docs.map((d) => ({
      clinicId,
      key: `tokens:${d._id}:${localDate(new Date())}`,
      value: tokens,
    })),
  ]);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await mongoose.connect(env.mongo);
  for (const m of allModels) await m.createIndexes();
  await bootstrap({ demo: process.argv.includes("--demo") });
  console.log(
    "Bootstrap complete" +
      (process.argv.includes("--demo") ? " · Synthetic demo data added" : ""),
  );
  await mongoose.disconnect();
}
