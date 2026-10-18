import { z } from "zod";
const text = z.string().trim().max(5000),
  short = z.string().trim().max(200),
  optional = short.optional();
const cents = z.number().int().min(0).max(100000000000);
const oid = z.string().regex(/^[0-9a-fA-F]{24}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const schemas = {
  login: z
    .object({ email: z.email(), password: z.string().min(1).max(128) })
    .strict(),
  patient: z
    .object({
      name: short.min(2),
      dob: date.optional().or(z.literal("")),
      age: z.number().int().min(0).max(125).optional(),
      gender: z.enum(["Male", "Female", "Other", "Unspecified"]),
      mobile: optional,
      alternateContact: optional,
      address: optional,
      city: optional,
      emergencyContact: optional,
      bloodGroup: optional,
      cnic: optional,
      allergies: text.optional(),
      medicalHistory: text.optional(),
      conditions: text.optional(),
      surgeries: text.optional(),
      medications: text.optional(),
      notes: text.optional(),
    })
    .strict(),
  doctor: z
    .object({
      name: short.min(2),
      specialization: optional,
      qualification: optional,
      registration: optional,
      phone: optional,
      email: z.email().optional().or(z.literal("")),
      fee: cents,
      followupFee: cents,
      duration: z.number().int().min(5).max(120),
      active: z.boolean().optional(),
      sessions: z
        .array(
          z
            .object({
              days: z.array(z.number().int().min(0).max(6)).min(1),
              start: time,
              end: time,
            })
            .refine((x) => x.start < x.end, "Session end must follow start"),
        )
        .max(14),
      leaves: z
        .array(z.object({ date, reason: short }))
        .max(365)
        .optional(),
    })
    .strict(),
  appointment: z
    .object({
      patientId: oid,
      doctorId: oid,
      startAt: z.iso.datetime({ offset: true }),
      type: z.enum(["Consultation", "Follow-up", "Walk-in"]),
      reason: optional,
      notes: text.optional(),
    })
    .strict(),
  consultation: z
    .object({
      complaint: text.optional(),
      symptoms: text.optional(),
      hpi: text.optional(),
      pastHistory: text.optional(),
      allergies: text.optional(),
      currentMedications: text.optional(),
      examination: text.optional(),
      workingDiagnosis: text.optional(),
      diagnosis: text.optional(),
      diagnosisCode: optional,
      terminologyVersion: optional,
      treatmentPlan: text.optional(),
      advice: text.optional(),
      followupInstructions: text.optional(),
      followupDate: date.optional().or(z.literal("")),
      vitals: z
        .object({
          bp: optional,
          heartRate: z.number().min(0).max(400).optional(),
          temperature: z.number().min(20).max(50).optional(),
          weight: z.number().min(0).max(700).optional(),
          height: z.number().min(0).max(300).optional(),
          spo2: z.number().min(0).max(100).optional(),
          respiratoryRate: z.number().min(0).max(150).optional(),
          glucose: z.number().min(0).max(2000).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  prescription: z
    .object({
      medicines: z
        .array(
          z
            .object({
              name: short.min(1),
              strength: optional,
              formulation: optional,
              dose: optional,
              route: optional,
              frequency: optional,
              duration: optional,
              quantity: z.number().int().min(0).max(100000).optional(),
              instructions: text.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(40),
      indication: text.optional(),
      advice: text.optional(),
      followupDate: date.optional().or(z.literal("")),
    })
    .strict(),
  invoice: z
    .object({
      patientId: oid,
      doctorId: oid.optional(),
      appointmentId: oid.optional(),
      consultationId: oid.optional(),
      services: z
        .array(
          z.object({
            name: short.min(1),
            quantity: z.number().int().min(1).max(10000),
            unitPrice: cents,
          }),
        )
        .min(1)
        .max(50),
      discount: cents,
      taxBasisPoints: z.number().int().min(0).max(10000),
      dueDate: date.optional().or(z.literal("")),
    })
    .strict(),
  payment: z
    .object({
      amount: cents.refine((x) => x > 0, "Amount must be positive"),
      method: z.enum(["Cash", "Bank Transfer", "Card", "Other"]),
      account: z.enum(["cash", "bank"]),
      key: z.string().min(12).max(100),
      reason: short.optional(),
      reference: optional,
    })
    .strict(),
  expense: z
    .object({
      description: short.min(2),
      category: short.min(1),
      amount: cents.refine((x) => x > 0),
      account: z.enum(["cash", "bank"]),
      method: z.enum(["Cash", "Bank Transfer", "Card", "Other"]),
      date,
    })
    .strict(),
  user: z
    .object({
      name: short.min(2),
      email: z.email(),
      password: z.string().min(12).max(128),
      role: z.enum([
        "owner",
        "doctor",
        "receptionist",
        "accountant",
        "manager",
      ]),
      doctorId: oid.optional(),
      clinicalAccess: z.boolean().optional(),
      permissions: z
        .array(
          z.enum([
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
          ]),
        )
        .max(20)
        .optional(),
    })
    .strict(),
  clinic: z
    .object({
      name: short.min(2),
      ownerName: short.min(2),
      email: z.email(),
      password: z.string().min(12).max(128),
      phone: optional,
      address: optional,
      city: optional,
      expiresAt: z.iso.datetime({ offset: true }),
      plan: short.min(1),
      doctorLimit: z.number().int().min(1).max(500),
      userLimit: z.number().int().min(1).max(2000),
    })
    .strict(),
  settings: z
    .object({
      name: short.min(2),
      ownerName: optional,
      address: optional,
      city: optional,
      phone: optional,
      whatsapp: optional,
      email: optional,
      registration: optional,
      timezone: z.string().refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone"),
      language: z.enum(["en", "ur", "roman"]),
      settings: z
        .object({
          tokenPrefix: short.min(1).max(10),
          invoicePrefix: short.min(1).max(10),
          allowOverbooking: z.boolean(),
          defaultFee: cents,
          taxBasisPoints: z.number().int().min(0).max(10000),
          invoiceFooter: text.optional(),
          prescriptionFooter: text.optional(),
          paperSize: z.enum(["A4", "A5"]),
          retentionDays: z.number().int().min(365).max(36500),
          openingHours: optional,
          closingHours: optional,
        })
        .strict(),
    })
    .strict(),
};
export function parse(name, data) {
  return schemas[name].parse(data);
}
export function reason(data) {
  return z.object({ reason: short.min(5) }).parse(data).reason;
}
