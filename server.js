import "dotenv/config";
import express from "express";
import { runAgent, approve, currentAssessment, whatIf, pendingApprovals, rawOrder, historySeries } from "./agent.js";
import { seedMockDemo, ensureDemoData } from "./demo.js";
import { deepScan, workflowsConfigured } from "./scan.js";
import { modelLabel } from "./llm.js";
import { PAYPAL_MODE } from "./paypal.js";
import { readAudit } from "./audit.js";
import { RULES } from "./risk.js";

const app = express();
app.use(express.static("public"));
app.use(express.json());

app.get("/api/assessment", async (req, res) => {
  try { res.json(await currentAssessment()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// What-if simulator: same deterministic rules, hypothetical shop. No AI, no PayPal writes.
app.post("/api/whatif", async (req, res) => {
  try { res.json(await whatIf(req.body || {})); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/config", (req, res) => res.json({
  paypal: PAYPAL_MODE,
  model: modelLabel(),
  // Only whether keys are configured. Secret values never leave the server.
  workflows: workflowsConfigured() ? { enabled: true, slug: process.env.WORKFLOW_SERVICE_SLUG } : { enabled: false },
  keys: { paypal: Boolean(process.env.PAYPAL_CLIENT_ID), groq: Boolean(process.env.GROQ_API_KEY), anthropic: Boolean(process.env.ANTHROPIC_API_KEY) },
  endpoints: [
    { api: "OAuth 2.0", method: "POST", path: "/v1/oauth2/token", used_for: "Access token (client credentials)" },
    { api: "Orders v2", method: "GET", path: "/v2/checkout/orders/{id}", used_for: "Live order, capture and tracker state" },
    { api: "Orders v2", method: "POST", path: "/v2/checkout/orders · /{id}/capture", used_for: "Seeding the demo shop" },
    { api: "Order Tracking", method: "POST", path: "/v2/checkout/orders/{id}/track", used_for: "Upload seller tracking (agent, code-approved)" },
    { api: "Payments v2", method: "POST", path: "/v2/payments/captures/{id}/refund", used_for: "Refund late orders (seller approval required)" },
    { api: "Disputes", method: "GET", path: "/v1/customer/disputes", used_for: "Open disputes for diagnosis" },
  ],
}));
app.get("/api/order/:id", async (req, res) => {
  try { res.json(await rawOrder(req.params.id)); } catch (e) { res.status(404).json({ error: e.message }); }
});
// Deep prevention scan: fans out on Render Workflows (or runs locally if not configured).
let scanning = false;
app.post("/api/deep-scan", async (req, res) => {
  if (scanning) return res.status(409).json({ error: "A scan is already running." });
  scanning = true;
  try { res.json(await deepScan()); } catch (e) { res.status(500).json({ error: e.message }); } finally { scanning = false; }
});
app.get("/api/history", (req, res) => res.json(historySeries()));
app.get("/api/model", (req, res) => res.json({ model: modelLabel(), paypal: PAYPAL_MODE }));
app.get("/api/rules", (req, res) => res.json(RULES));
app.get("/api/audit", (req, res) => res.json(readAudit()));

// Server-sent events: streams every agent step to the dashboard.
let busy = false; // one agent run at a time (shared demo shop)
app.get("/api/run", async (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (busy) { emit({ type: "error", text: "Another run is in progress. Try again in a minute." }); emit({ type: "done" }); return res.end(); }
  busy = true;
  try { await runAgent(emit); } catch (e) { emit({ type: "error", text: e.message }); } finally { busy = false; }
  emit({ type: "done" });
  res.end();
});

// Reset the offline demo shop so judges can run the whole flow again.
app.post("/api/reset", async (req, res) => {
  if (busy) return res.status(409).json({ ok: false, error: "An agent run is in progress." });
  try { await seedMockDemo(); pendingApprovals.clear(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post("/api/approve/:id", async (req, res) => {
  try {
    const { refund, assessment } = await approve(req.params.id);
    res.json({ ok: true, refund_id: refund.id, status: refund.status, assessment });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

await ensureDemoData();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Unhold running → http://localhost:${port}`));
