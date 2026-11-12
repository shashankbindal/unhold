// Unhold agent. CODE decides (risk.js: scores + allowed fixes). The AI model explains, finds root causes, and
// executes only the fixes code allowed, using values code supplies. Money movement needs seller approval.
import fs from "node:fs";
import { paypal } from "./paypal.js";
import { assess, simulate } from "./risk.js";
import { audit, hash } from "./audit.js";
import { createSession, modelLabel } from "./llm.js";

const STATE = "data/state.json";

export const pendingApprovals = new Map(); // id → { order_id, capture_id, amount, reason, payload_sha256 }

const history = () => JSON.parse(fs.readFileSync("data/history.json", "utf8"));
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { refunded: {} }; } };
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));

// Seed data merged with LIVE PayPal sandbox state (trackers, capture status) + local refund state.
export async function loadOrders() {
  const local = JSON.parse(fs.readFileSync("data/orders.json", "utf8"));
  const state = loadState();
  return Promise.all(local.map(async (o) => {
    const live = await paypal.getOrder(o.orderId);
    const pu = live.purchase_units[0];
    const cap = pu.payments?.captures?.[0];
    return {
      ...o,
      captureId: cap?.id || o.captureId,
      captureStatus: cap?.status,
      trackersOnPayPal: (pu.shipping?.trackers || []).map((t) => t.id),
      refunded: Boolean(state.refunded[o.orderId]) || Boolean(pu.payments?.refunds?.length),
    };
  }));
}

export async function rawOrder(id) {
  const known = JSON.parse(fs.readFileSync("data/orders.json", "utf8")).some((o) => o.orderId === id);
  if (!known) throw new Error("Unknown order");
  return paypal.getOrder(id);
}

export function historySeries() {
  const h = history();
  const refunds_by_day = Array.from({ length: 30 }, (_, i) => ({ day: i - 29, count: 0, amount: 0 }));
  for (const r of h.refunds_30d) { const d = refunds_by_day[29 - r.days_ago]; if (d) { d.count++; d.amount += r.amount; } }
  return { refunds_by_day, sku_orders_30d: h.sku_orders_30d, account_age_days: h.account_age_days, orders_30d: h.orders_30d, disputes_30d: h.disputes_30d, baseline_daily_sales_usd: h.baseline_daily_sales_usd, simulated: true };
}

export async function whatIf(scenario) {
  return simulate(await loadOrders(), history(), scenario);
}

export async function currentAssessment() {
  return assess(await loadOrders(), history());
}

const SYSTEM = `You are Unhold, an agent that helps small online sellers PREVENT PayPal payment holds and account limitations, and fix the causes of current ones.

Ground rules:
- Risk scores, risk factors and the allowed fix for each order are computed by deterministic code (get_risk_assessment). Do NOT invent or change scores, amounts or tracking numbers. Your job is to explain them, find root causes, and run the fixes code allows.
- Holds in this demo are SIMULATED (the PayPal sandbox never withholds funds). PayPal's internal risk decisions are not visible; speak of "likely" causes, never certainties.
- Public PayPal guidance: holds are typically released ~1 day after confirmed delivery when tracking from an approved carrier is on the transaction; at most 21 days. Disputes and high refund rates raise the chance of holds and limitations.

Steps:
1. Call get_risk_assessment, get_refund_notes, read_fulfillment_export and list_disputes.
2. For every order whose fix is UPLOAD_TRACKING, call upload_tracking(order_id). Code supplies the carrier and number from the seller's export.
3. For every order whose fix is REFUND, call propose_refund(order_id, reason). This only QUEUES it for the seller's approval; code sets the amount. The reason must describe THAT order's actual situation from the data (e.g. "not shipped after 9 days"); never borrow complaints from other orders' refund notes.
4. Read the refund notes and identify the product root cause(s): which SKU, what recurring problem, quoting notes VERBATIM as evidence.
5. Pre-dispute interception: for every order that is unshipped or late, draft a short, honest message the seller can send the buyer (apology + status + what happens next) BEFORE the buyer opens a dispute.
6. Call submit_report exactly once, then stop. Do not write any text after it. Plain English, short, for a non-technical seller. Lead with prevention: what will likely get held next and what to do this week.`;

const noInput = { type: "object", properties: {}, additionalProperties: false };
const tools = [
  { name: "get_risk_assessment", description: "Deterministic hold-risk scores, fired rules, and the allowed fix for every live PayPal order, plus account-level metrics (spike ratio, dispute rate, refund rates by SKU, days until the refund-rate limitation line).", input_schema: noInput },
  { name: "get_refund_notes", description: "Last 30 days of refunds with the buyer's reason text, grouped by SKU.", input_schema: noInput },
  { name: "read_fulfillment_export", description: "The seller's shipping-tool export (CSV): what shipped, carrier, tracking number.", input_schema: noInput },
  { name: "list_disputes", description: "Open PayPal disputes on the account (PayPal Disputes API).", input_schema: noInput },
  {
    name: "upload_tracking",
    description: "Attach the seller's tracking to the PayPal transaction (POST /v2/checkout/orders/{id}/track). Only works for orders whose code-assigned fix is UPLOAD_TRACKING; carrier and number come from the seller's export.",
    strict: true,
    input_schema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
  },
  {
    name: "propose_refund",
    description: "Queue a refund for the SELLER'S APPROVAL (does not move money). Only works for orders whose code-assigned fix is REFUND; code sets the amount.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" }, reason: { type: "string", description: "One sentence for the seller and buyer" } },
      required: ["order_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_report",
    description: "Final report for the dashboard. Call exactly once, at the end.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "2-3 sentences, prevention first" },
        order_explanations: {
          type: "array",
          items: {
            type: "object",
            properties: { order_id: { type: "string" }, explanation: { type: "string", description: "One plain-English sentence explaining this order's score" } },
            required: ["order_id", "explanation"],
            additionalProperties: false,
          },
        },
        sku_root_causes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              problem: { type: "string", description: "The recurring problem, e.g. 'wax melts in transit'" },
              evidence_quotes: { type: "array", items: { type: "string" }, description: "Refund notes quoted verbatim" },
              recommendation: { type: "string" },
            },
            required: ["sku", "problem", "evidence_quotes", "recommendation"],
            additionalProperties: false,
          },
        },
        prevention_checklist: { type: "array", items: { type: "string" }, description: "3-5 concrete actions for this week, most important first" },
        buyer_messages: {
          type: "array",
          description: "Draft messages to buyers of unshipped or late orders, to send before they open a dispute",
          items: {
            type: "object",
            properties: { order_id: { type: "string" }, message: { type: "string" } },
            required: ["order_id", "message"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "order_explanations", "sku_root_causes", "prevention_checklist", "buyer_messages"],
      additionalProperties: false,
    },
  },
];

async function runTool(name, input, ctx, emit) {
  const findOrder = (id) => ctx.assessment.orders.find((o) => o.orderId === id);
  switch (name) {
    case "get_risk_assessment": {
      const { orders, account } = ctx.assessment;
      return {
        orders: orders.map((o) => ({ order_id: o.orderId, item: o.item, sku: o.sku, amount: o.amount, age_days: o.daysAgo, risk: o.risk, level: o.level, factors: o.factors.map((f) => f.label), allowed_fix: o.fix?.type || null })),
        account,
      };
    }
    case "get_refund_notes": {
      const bySku = {};
      for (const r of history().refunds_30d) (bySku[r.sku] ||= []).push({ days_ago: r.days_ago, amount: r.amount, note: r.note });
      return bySku;
    }
    case "read_fulfillment_export":
      return fs.readFileSync("data/fulfillment.csv", "utf8");
    case "list_disputes": {
      try {
        const d = await paypal.listDisputes();
        return { disputes: (d.items || []).map((x) => ({ id: x.dispute_id, reason: x.reason, status: x.status, amount: x.dispute_amount })) };
      } catch (e) {
        return { disputes: [], note: `Disputes API unavailable: ${e.message.slice(0, 160)}` };
      }
    }
    case "upload_tracking": {
      const o = findOrder(input.order_id);
      if (!o || o.fix?.type !== "UPLOAD_TRACKING") throw new Error(`Blocked by policy: order ${input.order_id} has no code-approved UPLOAD_TRACKING fix.`);
      const payload = { order_id: o.orderId, capture_id: o.captureId, carrier: o.fix.carrier, tracking_number: o.fix.tracking_number };
      const r = await paypal.addTracking(o.orderId, o.captureId, o.fix.tracking_number, o.fix.carrier);
      audit("agent", "UPLOAD_TRACKING", payload, { paypal_order_id: r.id, status: r.status });
      (ctx.done ||= new Set()).add(o.orderId);
      emit({ type: "action", kind: "tracking", text: `Uploaded ${o.fix.carrier} tracking ${o.fix.tracking_number} to PayPal for ${o.item}. PayPal can now track delivery; this doesn't guarantee when funds are released`, ref: r.id });
      return { ok: true, order_id: r.id };
    }
    case "propose_refund": {
      const o = findOrder(input.order_id);
      if (!o || o.fix?.type !== "REFUND") throw new Error(`Blocked by policy: order ${input.order_id} has no code-approved REFUND fix.`);
      const payload = { order_id: o.orderId, capture_id: o.captureId, amount: o.fix.amount };
      const id = `apr_${Date.now().toString(36)}`;
      const approval = { ...payload, item: o.item, reason: input.reason, payload_sha256: hash(payload) };
      pendingApprovals.set(id, approval);
      audit("agent", "PROPOSE_REFUND", payload, { approval_id: id, reason: input.reason });
      emit({ type: "approval", id, ...approval });
      return { queued: true, approval_id: id, amount: o.fix.amount, note: "Waiting for seller approval. Not executed." };
    }
    case "submit_report": {
      const undone = ctx.assessment.orders.filter((o) => o.fix?.type === "UPLOAD_TRACKING" && !ctx.done?.has(o.orderId));
      if (undone.length) throw new Error(`Not finished: call upload_tracking for ${undone.map((o) => o.orderId).join(", ")} first, then submit_report.`);
      // Code check: keep only evidence quotes that appear verbatim in the stored refund notes.
      // Normalize: open models don't always follow the schema exactly.
      const arr = (x) => (Array.isArray(x) ? x : []);
      input = {
        summary: String(input.summary || ""),
        order_explanations: arr(input.order_explanations).filter((e) => e && e.order_id),
        sku_root_causes: arr(input.sku_root_causes).filter((c) => c && c.sku).map((c) => ({ ...c, evidence_quotes: arr(c.evidence_quotes).map(String) })),
        prevention_checklist: arr(input.prevention_checklist).map(String),
        buyer_messages: arr(input.buyer_messages).filter((m) => m && m.order_id && m.message),
      };
      const notes = history().refunds_30d.map((r) => r.note.toLowerCase());
      for (const c of input.sku_root_causes) {
        c.evidence_quotes = c.evidence_quotes.filter((q) => notes.some((n) => n.includes(q.toLowerCase().replace(/^["']|["']$/g, ""))));
      }
      emit({ type: "report", report: input });
      return { ok: true };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export async function runAgent(emit) {
  const ctx = { assessment: await currentAssessment() };
  audit("code", "ASSESS_BEFORE", { account_score: ctx.assessment.account.score });
  emit({ type: "assessment", phase: "before", data: ctx.assessment });

  emit({ type: "thought", text: `Model: ${modelLabel()}` });
  const session = createSession({
    system: SYSTEM,
    tools,
    userMessage: "Some of my PayPal money is on hold and I'm scared my account will get limited. Check everything, fix what you can, and tell me what to do so it doesn't happen again.",
  });
  let reported = false;
  for (let turn = 0; turn < 20; turn++) {
    const { texts, calls, stop } = await session.next();
    for (const t of texts) emit({ type: "thought", text: t });
    if (stop === "refusal") { emit({ type: "error", text: "The model declined this request." }); break; }
    if (stop !== "tool_use") {
      // Some models stop without calling submit_report; nudge once, then give up.
      if (reported || ctx.nudged) break;
      ctx.nudged = true;
      session.say("You have not finished. Complete any remaining steps, then call submit_report exactly once.");
      continue;
    }
    const results = [];
    for (const c of calls) {
      emit({ type: "tool", name: c.name, input: c.input });
      try {
        if (c.input?.__invalid_json !== undefined) throw new Error("Tool arguments were not valid JSON. Call the tool again with valid JSON.");
        const out = await runTool(c.name, c.input, ctx, emit);
        if (c.name === "submit_report") reported = true;
        results.push({ id: c.id, content: typeof out === "string" ? out : JSON.stringify(out) });
      } catch (e) {
        emit({ type: "error", text: `${c.name}: ${e.message.slice(0, 200)}` });
        results.push({ id: c.id, content: e.message.slice(0, 1000), isError: true });
      }
    }
    if (reported) break; // the report is the final output; don't wait for extra prose
    session.addResults(results);
  }

  const after = await currentAssessment();
  audit("code", "ASSESS_AFTER", { account_score: after.account.score });
  emit({ type: "assessment", phase: "after", data: after });
}

export async function approve(id) {
  const a = pendingApprovals.get(id);
  if (!a) throw new Error("Unknown or already used approval.");
  const payload = { order_id: a.order_id, capture_id: a.capture_id, amount: a.amount };
  if (hash(payload) !== a.payload_sha256) throw new Error("Payload changed since the proposal. A new approval is needed.");
  const state = loadState();
  if (state.refunded[a.order_id]) throw new Error("This order was already refunded.");
  audit("seller", "APPROVE_REFUND", payload, { approval_id: id });
  const r = await paypal.refund(a.capture_id, a.amount, a.reason);
  state.refunded[a.order_id] = r.id;
  saveState(state);
  pendingApprovals.delete(id);
  audit("system", "REFUND_EXECUTED", payload, { paypal_refund_id: r.id, status: r.status });
  return { refund: r, assessment: await currentAssessment() };
}
