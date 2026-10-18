import { Router } from "express";
import { z } from "zod";
import {
  Invoice,
  Patient,
  Doctor,
  Consultation,
  Appointment,
  Payment,
  Expense,
  Journal,
} from "../models/index.js";
import { permit } from "../middleware/auth.js";
import { parse, reason } from "../validators/index.js";
import {
  fail,
  id,
  page,
  transaction,
  next,
  audit,
  journal,
  serial,
} from "../utils/domain.js";
export const finance = Router();
export function totals(inv) {
  return {
    ...inv,
    balance: inv.status === "void" ? 0 : inv.total - inv.paid,
    netTotal: inv.status === "void" ? 0 : inv.total - inv.refunded,
    collected: inv.paid - inv.refunded,
    paymentStatus:
      inv.status === "void"
        ? "Void"
        : inv.paid >= inv.total
          ? "Paid"
          : inv.paid > 0
            ? "Partial"
            : "Unpaid",
  };
}
const get = async (Model, req, key, session) => {
  const d = await Model.findOne({ _id: id(key), clinicId: req.tid }).session(
    session || null,
  );
  if (!d) fail(404, "Record not found");
  return d;
};
finance.get("/invoices", permit("billing:read"), async (req, res) => {
  const { p, size, skip } = page(req);
  const q = { clinicId: req.tid };
  if (req.query.patientId) q.patientId = id(req.query.patientId);
  const [items, total] = await Promise.all([
    Invoice.find(q).sort({ createdAt: -1 }).skip(skip).limit(size).lean(),
    Invoice.countDocuments(q),
  ]);
  const patients = await Patient.find({
    clinicId: req.tid,
    _id: { $in: items.map((x) => x.patientId) },
  })
    .select("name mrn")
    .lean();
  res.json({
    items: items.map((x) => ({
      ...totals(x),
      patient: patients.find((p) => String(p._id) === String(x.patientId)),
    })),
    total,
    page: p,
    limit: size,
  });
});
finance.get("/invoices/:id", permit("billing:read"), async (req, res) => {
  const inv = await get(Invoice, req, req.params.id);
  const payments = await Payment.find({
    clinicId: req.tid,
    invoiceId: inv._id,
  }).sort({ createdAt: 1 });
  res.json({ ...totals(inv.toObject()), payments });
});
finance.post("/invoices", permit("billing:write"), async (req, res) => {
  const data = parse("invoice", req.body);
  let subtotal = 0;
  const services = data.services.map((s) => {
    const total = s.quantity * s.unitPrice;
    if (!Number.isSafeInteger(total)) fail(400, "Service amount is too large");
    subtotal += total;
    return { ...s, total };
  });
  if (data.discount > subtotal) fail(400, "Discount exceeds subtotal");
  const tax = Math.round(
    ((subtotal - data.discount) * data.taxBasisPoints) / 10000,
  );
  const total = subtotal - data.discount + tax;
  if (!Number.isSafeInteger(total) || total > 100000000000)
    fail(400, "Invoice total is too large");
  res.status(201).json(
    await transaction(async (session) => {
      await get(Patient, req, data.patientId, session);
      if (data.doctorId) await get(Doctor, req, data.doctorId, session);
      if (data.consultationId) {
        const c = await get(Consultation, req, data.consultationId, session);
        if (String(c.patientId) !== data.patientId)
          fail(400, "Patient does not match encounter");
        if (data.doctorId && String(c.doctorId) !== data.doctorId)
          fail(400, "Doctor does not match encounter");
        data.doctorId = String(c.doctorId);
        data.appointmentId = String(c.appointmentId);
      }
      if (data.appointmentId) {
        const a = await get(Appointment, req, data.appointmentId, session);
        if (String(a.patientId) !== data.patientId)
          fail(400, "Patient does not match appointment");
        if (data.doctorId && String(a.doctorId) !== data.doctorId)
          fail(400, "Doctor does not match appointment");
        data.doctorId = String(a.doctorId);
        await serial(req.tid, `bill:${a._id}`, session);
        if (
          await Invoice.exists({
            clinicId: req.tid,
            appointmentId: a._id,
            status: "posted",
          }).session(session)
        )
          fail(409, "This appointment is already billed");
      }
      const number = `${req.clinic.settings.invoicePrefix}-${String(await next(req.tid, "invoice", session)).padStart(6, "0")}`;
      const { taxBasisPoints, ...fields } = data;
      const [inv] = await Invoice.create(
        [
          {
            clinicId: req.tid,
            ...fields,
            number,
            services,
            subtotal,
            tax,
            total,
          },
        ],
        { session },
      );
      await journal(
        req,
        {
          event: "invoice",
          sourceId: inv._id,
          key: `invoice:${inv._id}`,
          amount: total,
          revenue: total - tax,
          taxLiability: tax,
          receivable: total,
          description: number,
        },
        session,
      );
      await audit(
        req,
        "invoice.posted",
        "Invoice",
        inv._id,
        { total },
        "",
        session,
      );
      return totals(inv.toObject());
    }),
  );
});
async function transactPayment(req, kind) {
  const data = parse("payment", req.body);
  if (kind === "refund") reason(req.body);
  return transaction(async (session) => {
    const existing = await Payment.findOne({
      clinicId: req.tid,
      key: data.key,
    }).session(session);
    if (existing) {
      if (
        String(existing.invoiceId) !== req.params.id ||
        existing.kind !== kind ||
        existing.amount !== data.amount ||
        existing.account !== data.account ||
        existing.method !== data.method
      )
        fail(409, "Idempotency key already used for another transaction");
      return existing;
    }
    const inv = await get(Invoice, req, req.params.id, session);
    const previousRefundTax = inv.refundedTax || 0;
    if (inv.status !== "posted") fail(409, "Invoice is void");
    if (data.method === "Cash" && data.account !== "cash")
      fail(400, "Cash payments must use cash account");
    if (
      ["Bank Transfer", "Card"].includes(data.method) &&
      data.account !== "bank"
    )
      fail(400, "Bank and card payments must use bank account");
    if (kind === "receipt") {
      if (data.amount > inv.total - inv.paid)
        fail(400, "Payment exceeds outstanding balance");
      inv.paid += data.amount;
    } else {
      if (data.amount > inv.paid - inv.refunded)
        fail(400, "Refund exceeds collected amount");
      inv.refunded += data.amount;
      inv.refundedTax = inv.total
        ? Math.round((inv.tax * inv.refunded) / inv.total)
        : 0;
    }
    const [p] = await Payment.create(
      [
        {
          clinicId: req.tid,
          invoiceId: inv._id,
          patientId: inv.patientId,
          kind,
          authorId: req.user._id,
          ...data,
        },
      ],
      { session },
    );
    await inv.save({ session });
    const signed = kind === "receipt" ? data.amount : -data.amount;
    await journal(
      req,
      {
        event: kind,
        sourceId: p._id,
        key: `payment:${p._id}`,
        amount: data.amount,
        account: data.account,
        cash: data.account === "cash" ? signed : 0,
        bank: data.account === "bank" ? signed : 0,
        revenue:
          kind === "refund"
            ? -(data.amount - (inv.refundedTax - previousRefundTax))
            : 0,
        taxLiability:
          kind === "refund" ? -(inv.refundedTax - previousRefundTax) : 0,
        receivable: kind === "receipt" ? -data.amount : 0,
        description: `${inv.number}: ${kind}`,
      },
      session,
    );
    await audit(
      req,
      `payment.${kind}`,
      "Payment",
      p._id,
      { amount: data.amount, account: data.account },
      data.reason || "",
      session,
    );
    return p;
  });
}
finance.post(
  "/invoices/:id/payments",
  permit("billing:write"),
  async (req, res) =>
    res.status(201).json(await transactPayment(req, "receipt")),
);
finance.post(
  "/invoices/:id/refunds",
  permit("finance:write"),
  async (req, res) =>
    res.status(201).json(await transactPayment(req, "refund")),
);
finance.post(
  "/invoices/:id/void",
  permit("finance:write"),
  async (req, res) => {
    const why = reason(req.body);
    res.json(
      await transaction(async (session) => {
        const inv = await get(Invoice, req, req.params.id, session);
        if (inv.status === "void") return totals(inv.toObject());
        if (inv.paid - inv.refunded > 0)
          fail(409, "Refund collected payments before voiding");
        const amount = inv.total - inv.refunded;
        inv.status = "void";
        inv.voidReason = why;
        inv.voidAt = new Date();
        await inv.save({ session });
        await journal(
          req,
          {
            event: "invoice-void",
            sourceId: inv._id,
            key: `void:${inv._id}`,
            amount,
            revenue: -(amount - (inv.tax - (inv.refundedTax || 0))),
            taxLiability: -(inv.tax - (inv.refundedTax || 0)),
            receivable: -(inv.total - inv.paid),
            description: inv.number,
          },
          session,
        );
        await audit(
          req,
          "invoice.voided",
          "Invoice",
          inv._id,
          {},
          why,
          session,
        );
        return totals(inv.toObject());
      }),
    );
  },
);
finance.get(
  "/patients/:id/statement",
  permit("billing:read"),
  async (req, res) => {
    await get(Patient, req, req.params.id);
    const items = await Invoice.find({
      clinicId: req.tid,
      patientId: req.params.id,
    })
      .sort({ createdAt: 1 })
      .lean();
    res.json({
      items: items.map(totals),
      balance: items.reduce(
        (sum, i) => sum + (i.status === "void" ? 0 : i.total - i.paid),
        0,
      ),
    });
  },
);
finance.get("/expenses", permit("finance:read"), async (req, res) => {
  const { p, size, skip } = page(req);
  const q = { clinicId: req.tid };
  res.json({
    items: await Expense.find(q).sort({ createdAt: -1 }).skip(skip).limit(size),
    total: await Expense.countDocuments(q),
    page: p,
    limit: size,
  });
});
finance.post("/expenses", permit("finance:write"), async (req, res) => {
  const data = parse("expense", req.body);
  const d = await Expense.create({
    clinicId: req.tid,
    ...data,
    authorId: req.user._id,
  });
  await audit(req, "expense.draft.created", "Expense", d._id);
  res.status(201).json(d);
});
finance.patch("/expenses/:id", permit("finance:write"), async (req, res) => {
  const data = parse("expense", req.body);
  res.json(
    await transaction(async (session) => {
      const e = await get(Expense, req, req.params.id, session);
      if (e.status !== "draft") fail(409, "Posted expenses cannot be edited");
      e.set(data);
      await e.save({ session });
      await audit(
        req,
        "expense.draft.updated",
        "Expense",
        e._id,
        {},
        "",
        session,
      );
      return e;
    }),
  );
});
finance.post("/expenses/:id/post", permit("finance:write"), async (req, res) =>
  res.json(
    await transaction(async (session) => {
      const e = await get(Expense, req, req.params.id, session);
      if (e.status === "posted") return e;
      if (e.status !== "draft") fail(409, "Expense is reversed");
      if (e.method === "Cash" && e.account !== "cash")
        fail(400, "Cash expense must use cash account");
      if (["Bank Transfer", "Card"].includes(e.method) && e.account !== "bank")
        fail(400, "Bank expense must use bank account");
      e.status = "posted";
      e.postedAt = new Date();
      await e.save({ session });
      await journal(
        req,
        {
          event: "expense",
          sourceId: e._id,
          key: `expense:${e._id}`,
          amount: e.amount,
          account: e.account,
          expenses: e.amount,
          cash: e.account === "cash" ? -e.amount : 0,
          bank: e.account === "bank" ? -e.amount : 0,
          description: e.description,
        },
        session,
      );
      await audit(req, "expense.posted", "Expense", e._id, {}, "", session);
      return e;
    }),
  ),
);
finance.post(
  "/expenses/:id/reverse",
  permit("finance:write"),
  async (req, res) => {
    const why = reason(req.body);
    res.json(
      await transaction(async (session) => {
        const e = await get(Expense, req, req.params.id, session);
        if (e.status === "reversed") return e;
        if (e.status !== "posted")
          fail(409, "Only posted expenses may be reversed");
        e.status = "reversed";
        e.reversedAt = new Date();
        e.reversalReason = why;
        await e.save({ session });
        await journal(
          req,
          {
            event: "expense-reversal",
            sourceId: e._id,
            key: `reverse:${e._id}`,
            amount: e.amount,
            account: e.account,
            expenses: -e.amount,
            cash: e.account === "cash" ? e.amount : 0,
            bank: e.account === "bank" ? e.amount : 0,
            description: e.description,
          },
          session,
        );
        await audit(
          req,
          "expense.reversed",
          "Expense",
          e._id,
          {},
          why,
          session,
        );
        return e;
      }),
    );
  },
);
finance.post(
  "/accounts/opening",
  permit("settings:write"),
  async (req, res) => {
    const data = z
      .object({
        account: z.enum(["cash", "bank"]),
        amount: z.number().int().min(0).max(100000000000),
        reason: z.string().min(5).max(200),
      })
      .strict()
      .parse(req.body);
    await transaction(async (session) => {
      await serial(req.tid, `opening:${data.account}`, session);
      if (
        await Journal.exists({
          clinicId: req.tid,
          key: `opening:${data.account}`,
        }).session(session)
      )
        fail(409, "Opening balance already recorded");
      await journal(
        req,
        {
          event: "opening",
          key: `opening:${data.account}`,
          amount: data.amount,
          account: data.account,
          cash: data.account === "cash" ? data.amount : 0,
          bank: data.account === "bank" ? data.amount : 0,
          description: data.reason,
        },
        session,
      );
      await audit(
        req,
        "account.opening",
        "Journal",
        data.account,
        { amount: data.amount },
        data.reason,
        session,
      );
    });
    res.json({ ok: true });
  },
);
