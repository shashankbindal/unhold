// Deep prevention scan. Runs on Render Workflows when RENDER_API_KEY and WORKFLOW_SERVICE_SLUG are set,
// otherwise runs the same task logic in-process (local development).
import fs from "node:fs";
import { Render } from "@renderinc/sdk";
import { loadOrders } from "./agent.js";
import { scoreShopCore, forecastGrowthCore, rootCauseForSkuCore, flaggedSkus, GROWTH, FIX_COMBOS } from "./workflows/core.js";
import { audit } from "./audit.js";

export const workflowsConfigured = () => Boolean(process.env.RENDER_API_KEY && process.env.WORKFLOW_SERVICE_SLUG);

async function snapshot() {
  const history = JSON.parse(fs.readFileSync("data/history.json", "utf8"));
  const orders = (await loadOrders()).map(({ orderId, captureId, item, sku, amount, shipped, carrier, tracking, daysAgo, trackersOnPayPal, refunded }) =>
    ({ orderId, captureId, item, sku, amount, shipped, carrier, tracking, daysAgo, trackersOnPayPal, refunded }));
  return { orders, history };
}

async function runLocally(snap) {
  const started = Date.now();
  const current = scoreShopCore(snap);
  const skus = flaggedSkus(current.sku_stats);
  const notesFor = (sku) => snap.history.refunds_30d.filter((r) => r.sku === sku).map((r) => r.note);
  const withRetry = async (fn, tries = 4) => {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) { if (i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 2000 * 2 ** i)); }
    }
  };
  const rootCauses = await Promise.all(skus.map((sku) => withRetry(() => rootCauseForSkuCore(sku, notesFor(sku), current.sku_stats[sku]))));
  const matrix = GROWTH.flatMap((m) => forecastGrowthCore(snap, m));
  return {
    executed_on: "local",
    task_runs: 1 + skus.length + GROWTH.length,
    duration_ms: Date.now() - started,
    current,
    root_causes: rootCauses,
    combos: FIX_COMBOS.map(({ key, label }) => ({ key, label })),
    growth: GROWTH,
    matrix,
  };
}

export async function deepScan() {
  const snap = await snapshot();
  if (!workflowsConfigured()) {
    const out = await runLocally(snap);
    audit("system", "DEEP_SCAN", { orders: snap.orders.length }, { executed_on: "local", task_runs: out.task_runs });
    return out;
  }
  const client = new Render(); // reads RENDER_API_KEY
  const slug = `${process.env.WORKFLOW_SERVICE_SLUG}/preventionScan`;
  const started = Date.now();
  const run = await client.workflows.runTask(slug, [snap]);
  if (run.status !== "completed") throw new Error(`Render Workflows run ${run.id} ${run.status}${run.error ? `: ${run.error}` : ""}`);
  const result = Array.isArray(run.results) ? run.results[0] : run.results;
  const out = { ...result, run_id: run.id, wall_ms: Date.now() - started };
  audit("system", "DEEP_SCAN", { orders: snap.orders.length, task: slug }, { executed_on: "render-workflows", run_id: run.id, task_runs: out.task_runs });
  return out;
}
