import {
  Patient,
  Doctor,
  Appointment,
  Consultation,
  Invoice,
  Payment,
  Expense,
  Journal,
} from "../models/index.js";
import { has } from "../middleware/auth.js";
import { range, fail } from "../utils/domain.js";
export const reportCatalog = [
  ["registrations", "New Patient Registrations", "patients"],
  ["patients", "Total Registered Patients", "patients"],
  ["visit-history", "Patient Visit History", "appointments"],
  ["returning", "Returning Patients", "appointments"],
  ["doctor-patients", "Doctor-wise Patient Count", "appointments"],
  ["daily-appointments", "Daily Appointments", "appointments"],
  ["weekly-appointments", "Weekly Appointments", "appointments"],
  ["monthly-appointments", "Monthly Appointments", "appointments"],
  ["doctor-appointments", "Doctor-wise Appointments", "appointments"],
  ["cancelled", "Cancelled Appointments", "appointments"],
  ["no-shows", "No Shows", "appointments"],
  ["completed", "Completed Consultations", "appointments"],
  ["daily-revenue", "Daily Revenue", "finance"],
  ["monthly-revenue", "Monthly Revenue", "finance"],
  ["doctor-billing", "Doctor-wise Billing", "finance"],
  ["fee-collection", "Consultation Fee Collection", "finance"],
  ["payment-methods", "Payment Method Summary", "finance"],
  ["pending-payments", "Pending Payments", "finance"],
  ["outstanding", "Outstanding Balances", "finance"],
  ["expenses", "Expenses Report", "finance"],
  ["profit-loss", "Profit & Loss", "finance"],
  ["cash-ledger", "Cash Ledger", "finance"],
  ["bank-ledger", "Bank Ledger", "finance"],
  ["refunds", "Refund Summary", "finance"],
  ["doctor-summary", "Doctor Activity Summary", "appointments"],
  ["waiting-time", "Average Patient Waiting Time", "appointments"],
  ["completion-rate", "Appointment Completion Rate", "appointments"],
  ["tokens", "Daily Token Statistics", "appointments"],
  ["peak-hours", "Peak Appointment Hours", "appointments"],
];
export function canReport(req, kind) {
  if (kind === "finance") return has(req, "finance:read");
  if (kind === "patients")
    return has(req, "patients:read") && has(req, "reports:read");
  return has(req, "appointments:read") && has(req, "reports:read");
}
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
function group(rows, key, values) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    const out = m.get(k) || {
      group: k,
      ...Object.fromEntries(values.map((v) => [v, 0])),
    };
    for (const v of values) out[v] += Number(r[v]) || 0;
    m.set(k, out);
  }
  return [...m.values()];
}
export async function report(req, name) {
  const def = reportCatalog.find((d) => d[0] === name);
  if (!def) fail(404, "Unknown report");
  if (!canReport(req, def[2])) fail(403, "Report permission is required");
  const { from, to, start, end } = range(req);
  const q = { clinicId: req.tid };
  const dateQ = { $gte: start, $lt: end };
  const at = { ...q, startAt: dateQ };
  if (req.user.role === "doctor") at.doctorId = req.user.doctorId;
  else if (req.query.doctorId) at.doctorId = req.query.doctorId;
  const cap = 10000;
  async function find(Model, filter, select) {
    const rows = await Model.find(filter)
      .select(select || "")
      .sort({ createdAt: 1 })
      .limit(cap + 1)
      .lean();
    if (rows.length > cap)
      fail(400, "Report exceeds 10,000 rows. Narrow the date range");
    return rows;
  }
  const doctors = await Doctor.find(q).select("name").lean();
  const dname = (x) =>
    doctors.find((d) => String(d._id) === String(x))?.name || "Unassigned";
  let rows = [],
    metrics = {},
    moneyColumns = [],
    notice = "";
  if (def[2] === "patients") {
    const pq = {
      ...q,
      ...(name === "registrations" ? { createdAt: dateQ } : {}),
    };
    if (req.user.role === "doctor")
      pq._id = {
        $in: await Appointment.distinct("patientId", {
          ...q,
          doctorId: req.user.doctorId,
        }),
      };
    const items = await find(Patient, pq, "mrn name mobile gender createdAt");
    rows = items.map((p) => ({
      MRN: p.mrn,
      Patient: p.name,
      Mobile: p.mobile || "",
      Gender: p.gender,
      Registered: p.createdAt.toISOString(),
    }));
    metrics = { Patients: items.length };
    if (name === "patients")
      notice =
        "All-time registered patient count. Date range does not limit this roster.";
  } else if (def[2] === "appointments") {
    let items = await find(Appointment, at);
    if (name === "cancelled")
      items = items.filter((x) => x.status === "Cancelled");
    if (name === "no-shows")
      items = items.filter((x) => x.status === "No Show");
    if (name === "completed")
      items = items.filter((x) => x.status === "Completed");
    const patients = await Patient.find({
      ...q,
      _id: { $in: items.map((a) => a.patientId) },
    })
      .select("name mrn")
      .lean();
    const pname = (x) =>
      patients.find((p) => String(p._id) === String(x))?.name ||
      "Archived patient";
    metrics = {
      Appointments: items.length,
      Completed: items.filter((x) => x.status === "Completed").length,
    };
    rows = items.map((a) => ({
      Date: a.localDate,
      Time: a.startAt.toISOString(),
      Patient: pname(a.patientId),
      Doctor: dname(a.doctorId),
      Token: a.token || "",
      Status: a.status,
    }));
    if (name === "doctor-patients") {
      rows = doctors
        .filter(
          (d) =>
            req.user.role !== "doctor" ||
            String(d._id) === String(req.user.doctorId),
        )
        .map((d) => ({
          Doctor: d.name,
          Patients: new Set(
            items
              .filter((a) => String(a.doctorId) === String(d._id))
              .map((a) => String(a.patientId)),
          ).size,
        }));
    }
    if (["doctor-appointments", "doctor-summary"].includes(name)) {
      rows = doctors
        .filter(
          (d) =>
            req.user.role !== "doctor" ||
            String(d._id) === String(req.user.doctorId),
        )
        .map((d) => {
          const a = items.filter((x) => String(x.doctorId) === String(d._id));
          return {
            Doctor: d.name,
            Appointments: a.length,
            Completed: a.filter((x) => x.status === "Completed").length,
            Cancelled: a.filter((x) => x.status === "Cancelled").length,
          };
        });
      notice =
        "Counts describe activity only; they are not clinical quality rankings.";
    }
    if (name === "returning") {
      const seen = await Appointment.distinct("patientId", {
        ...q,
        startAt: { $lt: start },
        status: "Completed",
        ...(req.user.role === "doctor" ? { doctorId: req.user.doctorId } : {}),
      });
      const set = new Set(seen.map(String));
      const uniq = [
        ...new Set(
          items
            .filter((a) => set.has(String(a.patientId)))
            .map((a) => String(a.patientId)),
        ),
      ];
      rows = uniq.map((x) => ({
        Patient: pname(x),
        Visits: items.filter((a) => String(a.patientId) === x).length,
      }));
      metrics = { ReturningPatients: rows.length };
    }
    if (name === "waiting-time") {
      const called = items.filter((a) => a.checkedInAt && a.calledAt);
      rows = called.map((a) => ({
        Patient: pname(a.patientId),
        Doctor: dname(a.doctorId),
        Date: a.localDate,
        Minutes: Math.max(0, Math.round((a.calledAt - a.checkedInAt) / 60000)),
      }));
      metrics = {
        MeasuredPatients: rows.length,
        AverageMinutes: rows.length
          ? Math.round(sum(rows, "Minutes") / rows.length)
          : 0,
      };
    }
    if (name === "completion-rate") {
      rows = [
        {
          Appointments: items.length,
          Completed: metrics.Completed,
          CompletionPercent: items.length
            ? Math.round((metrics.Completed / items.length) * 100)
            : 0,
        },
      ];
      metrics = rows[0];
      notice =
        "Denominator includes all appointments in the selected period, including cancelled and no-show appointments.";
    }
    if (name === "tokens") {
      rows = group(
        items
          .filter((x) => x.token)
          .map((a) => ({
            date: a.localDate,
            Issued: 1,
            Completed: a.status === "Completed" ? 1 : 0,
          })),
        (r) => r.date,
        ["Issued", "Completed"],
      );
    }
    if (name === "peak-hours") {
      rows = group(
        items.map((a) => ({
          hour: new Intl.DateTimeFormat("en-GB", {
            timeZone: req.clinic.timezone,
            hour: "2-digit",
            hourCycle: "h23",
          }).format(a.startAt),
          Appointments: 1,
        })),
        (r) => `${r.hour}:00`,
        ["Appointments"],
      );
    }
  } else {
    const entries = await find(Journal, { ...q, createdAt: dateQ });
    metrics = {
      Revenue: sum(entries, "revenue"),
      RecognizedExpenses: sum(entries, "expenses"),
      NetOperatingResult: sum(entries, "revenue") - sum(entries, "expenses"),
      CashMovement: sum(entries, "cash"),
      BankMovement: sum(entries, "bank"),
    };
    if (["daily-revenue", "monthly-revenue"].includes(name)) {
      rows = group(
        entries
          .filter((e) => e.revenue)
          .map((e) => ({
            period: new Intl.DateTimeFormat("en-CA", {
              timeZone: req.clinic.timezone,
              year: "numeric",
              month: "2-digit",
              ...(name === "daily-revenue" ? { day: "2-digit" } : {}),
            }).format(e.createdAt),
            Revenue: e.revenue,
          })),
        (r) => r.period,
        ["Revenue"],
      );
      moneyColumns = ["Revenue"];
    }
    if (name === "profit-loss") {
      rows = [
        {
          Item: "Net invoice revenue after discounts, refunds and voids",
          Amount: metrics.Revenue,
        },
        {
          Item: "Recognized operating expenses",
          Amount: metrics.RecognizedExpenses,
        },
        { Item: "Net operating result", Amount: metrics.NetOperatingResult },
      ];
      moneyColumns = ["Amount"];
      notice =
        "Invoice revenue excludes collected tax and is recognized when posted; expenses are recognized and paid when posted. Unpaid expenses, accruals and doctor revenue sharing are not supported in V1. Cash receipts are reported separately.";
    }
    if (["cash-ledger", "bank-ledger"].includes(name)) {
      const field = name === "cash-ledger" ? "cash" : "bank";
      const opening = await Journal.aggregate([
        { $match: { clinicId: req.tid, createdAt: { $lt: start } } },
        { $group: { _id: null, balance: { $sum: `$${field}` } } },
      ]);
      let balance = opening[0]?.balance || 0;
      metrics = { OpeningBalance: balance };
      rows = entries
        .filter((e) => e[field] !== 0)
        .map((e) => {
          balance += e[field];
          return {
            Date: e.createdAt.toISOString(),
            Event: e.event,
            Description: e.description || "",
            In: e[field] > 0 ? e[field] : 0,
            Out: e[field] < 0 ? -e[field] : 0,
            Balance: balance,
          };
        });
      metrics.ClosingBalance = balance;
      moneyColumns = ["In", "Out", "Balance"];
    }
    if (["pending-payments", "outstanding", "doctor-billing"].includes(name)) {
      let invoices = await find(
        Invoice,
        name === "doctor-billing"
          ? { ...q, createdAt: dateQ, status: "posted" }
          : { ...q, status: "posted" },
      );
      if (req.query.doctorId)
        invoices = invoices.filter(
          (i) => String(i.doctorId) === req.query.doctorId,
        );
      const ps = await Patient.find({
        ...q,
        _id: { $in: invoices.map((i) => i.patientId) },
      })
        .select("name mrn")
        .lean();
      rows = invoices.map((i) => ({
        Invoice: i.number,
        Patient:
          ps.find((p) => String(p._id) === String(i.patientId))?.name || "",
        Doctor: dname(i.doctorId),
        Total: i.total - i.refunded,
        Collected: i.paid - i.refunded,
        Balance: i.total - i.paid,
      }));
      if (name !== "doctor-billing") {
        rows = rows.filter((r) => r.Balance > 0);
        notice =
          "Current outstanding balances across all dates. Date range does not limit unpaid accounts.";
      }
      metrics = {
        Invoiced: sum(rows, "Total"),
        Collected: sum(rows, "Collected"),
        Outstanding: sum(rows, "Balance"),
      };
      moneyColumns = ["Total", "Collected", "Balance"];
      if (name === "doctor-billing")
        rows = group(rows, (r) => r.Doctor, ["Total", "Collected", "Balance"]);
    }
    if (["fee-collection", "payment-methods", "refunds"].includes(name)) {
      const payments = await find(Payment, {
        ...q,
        createdAt: dateQ,
        ...(name === "refunds" ? { kind: "refund" } : {}),
      });
      let applicable = payments;
      if (name === "fee-collection") {
        const ids = await Invoice.distinct("_id", {
          ...q,
          appointmentId: { $exists: true },
        });
        const set = new Set(ids.map(String));
        applicable = payments.filter((p) => set.has(String(p.invoiceId)));
        notice =
          "Receipts for invoices linked to clinic visits. Includes additional services billed on those invoices.";
      }
      rows = applicable.map((p) => ({
        Date: p.createdAt.toISOString(),
        Method: p.method,
        Kind: p.kind,
        Amount: p.kind === "receipt" ? p.amount : -p.amount,
        Reference: p.reference || "",
        Reason: p.reason || "",
      }));
      metrics = {
        Received: sum(
          applicable.filter((p) => p.kind === "receipt"),
          "amount",
        ),
        Refunded: sum(
          applicable.filter((p) => p.kind === "refund"),
          "amount",
        ),
      };
      moneyColumns = ["Amount"];
      if (name === "payment-methods")
        rows = group(rows, (r) => r.Method, ["Amount"]);
    }
    if (name === "expenses") {
      rows = entries
        .filter((e) => ["expense", "expense-reversal"].includes(e.event))
        .map((e) => ({
          Date: e.createdAt.toISOString(),
          Description: e.description,
          Event: e.event,
          Account: e.account,
          Amount: e.expenses,
        }));
      metrics = { RecognizedExpenses: sum(rows, "Amount") };
      moneyColumns = ["Amount"];
      notice =
        "Posted expenses and reversals by posting date. Drafts are excluded.";
    }
  }
  return {
    name: def[1],
    slug: name,
    from,
    to,
    rows,
    metrics,
    moneyColumns,
    financial: def[2] === "finance",
    notice,
    generatedAt: new Date().toISOString(),
  };
}
