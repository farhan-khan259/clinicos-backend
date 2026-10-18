import { Router } from "express";
import ExcelJS from "exceljs";
import { report, reportCatalog, canReport } from "../services/reports.js";
import { audit, page, range, localDate } from "../utils/domain.js";
import { has } from "../middleware/auth.js";
import {
  Patient,
  Appointment,
  Consultation,
  Invoice,
  Journal,
  Doctor,
} from "../models/index.js";
export const reports = Router();
reports.get("/reports", async (req, res) =>
  res.json(
    reportCatalog
      .filter((d) => canReport(req, d[2]))
      .map(([slug, name, group]) => ({ slug, name, group })),
  ),
);
reports.get("/reports/:name", async (req, res) => {
  const data = await report(req, req.params.name);
  const { p, size, skip } = page(req);
  res.json({
    ...data,
    rows: data.rows.slice(skip, skip + size),
    total: data.rows.length,
    page: p,
    limit: size,
  });
});
reports.get("/reports/:name/export", async (req, res) => {
  const data = await report(req, req.params.name);
  await audit(req, "report.exported", "Report", req.params.name, {
    from: data.from,
    to: data.to,
    format: req.query.format || "csv",
  });
  const keys = Object.keys(data.rows[0] || {});
  const convert = (k, v) =>
    data.moneyColumns.includes(k) ? Number(v) / 100 : v;
  if (req.query.format === "xlsx") {
    const book = new ExcelJS.Workbook();
    book.creator = "Ahmed Solutions";
    const sheet = book.addWorksheet(data.name.slice(0, 31));
    sheet.addRow([req.clinic.name]);
    sheet.addRow([data.name]);
    sheet.addRow([`${data.from} to ${data.to}`]);
    sheet.addRow([data.notice]);
    sheet.addRow([]);
    sheet.addRow(keys);
    for (const r of data.rows) sheet.addRow(keys.map((k) => convert(k, r[k])));
    sheet.getRow(6).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(6).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF086A77" },
    };
    sheet.columns = keys.map((k) => ({
      width: Math.max(18, Math.min(45, k.length + 12)),
    }));
    keys.forEach((k, i) => {
      if (data.moneyColumns.includes(k))
        sheet.getColumn(i + 1).numFmt = "#,##0.00";
    });
    sheet.autoFilter = {
      from: { row: 6, column: 1 },
      to: { row: 6, column: Math.max(1, keys.length) },
    };
    sheet.views = [{ state: "frozen", ySplit: 6 }];
    sheet.pageSetup = {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "6:6",
    };
    sheet.headerFooter = {
      oddHeader: req.clinic.name,
      oddFooter: "Page &P of &N",
    };
    res
      .set(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .attachment(`${data.slug}.xlsx`);
    await book.xlsx.write(res);
    res.end();
  } else {
    const safe = (v) => {
      let s = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const output = [
      keys.map(safe).join(","),
      ...data.rows.map((r) =>
        keys.map((k) => safe(convert(k, r[k]))).join(","),
      ),
    ].join("\r\n");
    res
      .type("text/csv; charset=utf-8")
      .attachment(`${data.slug}.csv`)
      .send("\uFEFF" + output);
  }
});
reports.get("/dashboard", async (req, res) => {
  const { start, end, from, to } = range(req),
    q = { clinicId: req.tid },
    dateQ = { $gte: start, $lt: end };
  const aq = { ...q, startAt: dateQ };
  if (req.user.role === "doctor") aq.doctorId = req.user.doctorId;
  const appointmentsAllowed = has(req, "appointments:read"),
    patientsAllowed = has(req, "patients:read"),
    financeAllowed =
      has(req, "finance:read") || req.user.role === "receptionist";
  const [appointments, patientCount, newPatients, doctors] = await Promise.all([
    appointmentsAllowed ? Appointment.find(aq).lean() : [],
    patientsAllowed
      ? Patient.countDocuments({
          ...q,
          ...(req.user.role === "doctor"
            ? {
                _id: {
                  $in: await Appointment.distinct("patientId", {
                    ...q,
                    doctorId: req.user.doctorId,
                  }),
                },
              }
            : {}),
        })
      : 0,
    patientsAllowed && req.user.role !== "doctor"
      ? Patient.countDocuments({ ...q, createdAt: dateQ })
      : 0,
    Doctor.find(q).select("name").lean(),
  ]);
  const waiting = appointments.filter((a) =>
    ["Waiting", "Checked In", "In Consultation"].includes(a.status),
  );
  const recent = appointments
    .slice()
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, 8);
  const ps = await Patient.find({
    ...q,
    _id: { $in: recent.map((a) => a.patientId) },
  })
    .select("name mrn")
    .lean();
  const metrics = {
    Appointments: appointments.length,
    RegisteredPatients: patientCount,
    NewPatients: newPatients,
    Waiting: waiting.length,
    Completed: appointments.filter((a) => a.status === "Completed").length,
  };
  if (financeAllowed) {
    const entries = await Journal.find({ ...q, createdAt: dateQ }).lean();
    const sum = (k) => entries.reduce((s, e) => s + e[k], 0);
    metrics.Revenue = sum("revenue");
    metrics.Received = entries
      .filter((e) => e.event === "receipt")
      .reduce((s, e) => s + e.amount, 0);
    const outstanding = await Invoice.aggregate([
      { $match: { ...q, status: "posted" } },
      {
        $group: {
          _id: null,
          balance: { $sum: { $subtract: ["$total", "$paid"] } },
        },
      },
    ]);
    metrics.Pending = outstanding[0]?.balance || 0;
    if (has(req, "finance:read")) {
      metrics.Expenses = sum("expenses");
      metrics.NetOperatingResult = sum("revenue") - sum("expenses");
    }
  }
  const trends = new Map();
  for (const a of appointments) {
    const d = trends.get(a.localDate) || {
      date: a.localDate,
      visits: 0,
      completed: 0,
    };
    d.visits++;
    if (a.status === "Completed") d.completed++;
    trends.set(a.localDate, d);
  }
  const revenueTrend = has(req, "finance:read")
    ? await Journal.aggregate([
        {
          $match: {
            clinicId: req.tid,
            createdAt: { $gte: new Date(new Date().getFullYear(), 0, 1) },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                date: "$createdAt",
                format: "%Y-%m",
                timezone: req.clinic.timezone,
              },
            },
            revenue: { $sum: "$revenue" },
          },
        },
        { $sort: { _id: 1 } },
        { $project: { _id: 0, month: "$_id", revenue: 1 } },
      ])
    : [];
  res.json({
    from,
    to,
    metrics,
    revenueTrend,
    appointments: recent.map((a) => ({
      ...a,
      patient: ps.find((p) => String(p._id) === String(a.patientId)),
      doctor: doctors.find((d) => String(d._id) === String(a.doctorId)),
    })),
    trend: [...trends.values()].sort((a, b) => a.date.localeCompare(b.date)),
    doctorCounts: doctors
      .filter(
        (d) =>
          req.user.role !== "doctor" ||
          String(d._id) === String(req.user.doctorId),
      )
      .map((d) => ({
        name: d.name,
        visits: appointments.filter((a) => String(a.doctorId) === String(d._id))
          .length,
      })),
    upcoming: appointmentsAllowed
      ? await Appointment.countDocuments({
          ...q,
          ...(req.user.role === "doctor"
            ? { doctorId: req.user.doctorId }
            : {}),
          startAt: { $gte: new Date() },
          status: "Scheduled",
        })
      : 0,
  });
});

reports.get("/reports/:name/print", async (req, res) => {
  const data = await report(req, req.params.name);
  await audit(req, "report.printed", "Report", req.params.name, {
    from: data.from,
    to: data.to,
  });
  res.json(data);
});
