// Render Workflow service for Unhold. Each task runs on its own Render instance.
// Deploy as a Workflow service: build `npm install`, start `node workflows/main.js`.
// Trigger from the web app with: new Render().workflows.runTask(`${WORKFLOW_SERVICE_SLUG}/preventionScan`, [snapshot])
import { task } from "@renderinc/sdk/workflows";
import { scoreShopCore, forecastGrowthCore, rootCauseForSkuCore, flaggedSkus, GROWTH, FIX_COMBOS } from "./core.js";

const scoreShop = task({ name: "scoreShop", timeoutSeconds: 120 }, function scoreShop(_ctx, snapshot) {
  return scoreShopCore(snapshot);
});

const forecastGrowth = task({ name: "forecastGrowth", timeoutSeconds: 120 }, function forecastGrowth(_ctx, snapshot, multiplier) {
  return forecastGrowthCore(snapshot, multiplier);
});

// Groq's free tier rate-limits often; retries with exponential backoff absorb that.
const rootCauseForSku = task(
  { name: "rootCauseForSku", timeoutSeconds: 180, retry: { maxRetries: 4, waitDurationMs: 2000, backoffScaling: 2 } },
  async function rootCauseForSku(_ctx, sku, notes, stats) {
    return rootCauseForSkuCore(sku, notes, stats);
  },
);

task({ name: "preventionScan", timeoutSeconds: 600 }, async function preventionScan(ctx, snapshot) {
  const started = Date.now();
  const current = await ctx.run(scoreShop, snapshot);
  const skus = flaggedSkus(current.sku_stats);
  const notesFor = (sku) => snapshot.history.refunds_30d.filter((r) => r.sku === sku).map((r) => r.note);
  const [rootCauses, columns] = await Promise.all([
    Promise.all(skus.map((sku) => ctx.run(rootCauseForSku, sku, notesFor(sku), current.sku_stats[sku]))),
    Promise.all(GROWTH.map((m) => ctx.run(forecastGrowth, snapshot, m))),
  ]);
  return {
    executed_on: "render-workflows",
    task_runs: 1 + skus.length + GROWTH.length,
    duration_ms: Date.now() - started,
    current,
    root_causes: rootCauses,
    combos: FIX_COMBOS.map(({ key, label }) => ({ key, label })),
    growth: GROWTH,
    matrix: columns.flat(),
  };
});
