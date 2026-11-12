// Minimal PayPal REST client (sandbox). Every call returns parsed JSON or throws with PayPal's error body.
import "dotenv/config";
import fs from "node:fs";

const BASE = process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com";
let cached = { token: null, exp: 0 };

async function token() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`PayPal auth failed: ${JSON.stringify(j)}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

async function call(method, path, body, extraHeaders = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`PayPal ${method} ${path} → ${r.status}: ${text.slice(0, 500)}`);
  return data;
}

const real = {
  createOrder: (amount, description, invoiceId) =>
    call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: "USD", value: amount },
        description,
        invoice_id: invoiceId,
        shipping: {
          name: { full_name: "Test Buyer" },
          address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
        },
      }],
      payment_source: {
        paypal: { experience_context: { shipping_preference: "SET_PROVIDED_ADDRESS", user_action: "PAY_NOW", return_url: "https://example.com/return", cancel_url: "https://example.com/cancel" } },
      },
    }),
  getOrder: (id) => call("GET", `/v2/checkout/orders/${id}`),
  captureOrder: (id) => call("POST", `/v2/checkout/orders/${id}/capture`, {}),
  addTracking: (orderId, captureId, trackingNumber, carrier) =>
    call("POST", `/v2/checkout/orders/${orderId}/track`, {
      capture_id: captureId,
      tracking_number: trackingNumber,
      carrier,
      notify_payer: true,
    }),
  refund: (captureId, amount, note) =>
    call("POST", `/v2/payments/captures/${captureId}/refund`, {
      amount: { currency_code: "USD", value: amount },
      note_to_payer: note?.slice(0, 255),
    }, { "PayPal-Request-Id": `unhold-refund-${captureId}-${amount}` }),
  listDisputes: () => call("GET", "/v1/customer/disputes?page_size=20"),
};

// ---------------------------------------------------------------------------------------------
// OFFLINE MOCK PayPal: used only when no sandbox credentials are available (PAYPAL_MODE=mock, or
// PAYPAL_CLIENT_ID empty). Mimics the response shapes of the endpoints above, persists to
// data/mock-paypal.json, and is labelled "MOCK PayPal" everywhere in the UI. Not a real PayPal call.
const MOCK_FILE = "data/mock-paypal.json";
const rid = (p) => p + Math.random().toString(36).slice(2, 12).toUpperCase();
const mdb = () => { try { return JSON.parse(fs.readFileSync(MOCK_FILE, "utf8")); } catch { return { orders: {} }; } };
const msave = (db) => { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(MOCK_FILE, JSON.stringify(db, null, 2)); };
const mget = (db, id) => { const o = db.orders[id]; if (!o) throw new Error(`PayPal GET order → 404: RESOURCE_NOT_FOUND ${id}`); return o; };

const mock = {
  async createOrder(amount, description, invoiceId) {
    const db = mdb(); const id = rid("MOCK");
    db.orders[id] = { id, status: "CREATED", purchase_units: [{ amount: { currency_code: "USD", value: amount }, description, invoice_id: invoiceId, shipping: { trackers: [] }, payments: {} }] };
    msave(db);
    return { id, status: "CREATED", links: [{ rel: "payer-action", href: `(mock) auto-approved ${id}` }] };
  },
  async getOrder(id) { return mget(mdb(), id); },
  async captureOrder(id) {
    const db = mdb(); const o = mget(db, id);
    o.status = "COMPLETED";
    o.purchase_units[0].payments.captures = [{ id: rid("CAP"), status: "COMPLETED", amount: o.purchase_units[0].amount }];
    msave(db); return o;
  },
  async addTracking(orderId, captureId, trackingNumber, carrier) {
    const db = mdb(); const o = mget(db, orderId);
    if (o.purchase_units[0].payments.captures?.[0]?.id !== captureId) throw new Error("PayPal POST track → 422: capture_id does not belong to this order");
    o.purchase_units[0].shipping.trackers.push({ id: `${captureId}-${trackingNumber}`, status: "SHIPPED", carrier });
    msave(db); return { id: orderId, status: o.status };
  },
  async refund(captureId, amount) {
    const db = mdb();
    const o = Object.values(db.orders).find((x) => x.purchase_units[0].payments.captures?.[0]?.id === captureId);
    if (!o) throw new Error("PayPal POST refund → 404: capture not found");
    const r = { id: rid("REF"), status: "COMPLETED", amount: { currency_code: "USD", value: amount } };
    (o.purchase_units[0].payments.refunds ||= []).push(r);
    msave(db); return r;
  },
  async listDisputes() { return { items: [] }; },
};

export const PAYPAL_MODE = process.env.PAYPAL_MODE || (process.env.PAYPAL_CLIENT_ID ? "sandbox" : "mock");
export const paypal = PAYPAL_MODE === "mock" ? mock : real;
if (PAYPAL_MODE === "mock") console.warn("⚠  PAYPAL_MODE=mock: using the OFFLINE MOCK PayPal (no sandbox credentials). Labelled in the UI.");
