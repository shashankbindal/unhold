// Pure task logic shared by the Render Workflow service (workflows/main.js) and the local fallback (scan.js).
// Everything comes in as arguments: workflow instances don't share the web service's disk.
import { assess, simulate } from "../risk.js";

export const FIX_COMBOS = [
  { key: "none", label: "No changes", scenario: {} },
  { key: "track", label: "Upload tracking", scenario: { uploadAllTracking: true } },
  { key: "late", label: "Resolve late orders", scenario: { resolveLateOrders: true } },
  { key: "sku", label: "Fix problem product", scenario: { fixSku: true } },
  { key: "track+late", label: "Tracking + late orders", scenario: { uploadAllTracking: true, resolveLateOrders: true } },
  { key: "track+sku", label: "Tracking + product", scenario: { uploadAllTracking: true, fixSku: true } },
  { key: "late+sku", label: "Late orders + product", scenario: { resolveLateOrders: true, fixSku: true } },
  { key: "all", label: "All three fixes", scenario: { uploadAllTracking: true, resolveLateOrders: true, fixSku: true } },
];
export const GROWTH = [1, 1.5, 2, 3];

export function flaggedSkus(stats) {
  return Object.entries(stats).filter(([, s]) => s.vs_shop > 2 && s.refunds >= 3).map(([sku]) => sku);
}

export function scoreShopCore(snapshot) {
  const a = assess(snapshot.orders, snapshot.history);
  return {
    score: a.account.score,
    at_risk_usd: a.account.at_risk_usd,
    days_to_limitation_line: a.account.days_to_limitation_line,
    high_orders: a.orders.filter((o) => o.level === "high").map((o) => ({ orderId: o.orderId, item: o.item, risk: o.risk })),
    sku_stats: a.account.sku_stats,
  };
}

// One column of the growth x fixes matrix: every fix combination at one sales multiplier.
export function forecastGrowthCore(snapshot, multiplier) {
  const skus = flaggedSkus(assess(snapshot.orders, snapshot.history).account.sku_stats);
  return FIX_COMBOS.map((c) => {
    const { fixSku, ...rest } = c.scenario;
    const r = simulate(snapshot.orders, snapshot.history, { ...rest, fixSkus: fixSku ? skus : [], salesMultiplier: multiplier });
    return { combo: c.key, multiplier, score: r.account.score, at_risk_usd: r.account.at_risk_usd, days_to_line: r.account.days_to_limitation_line };
  });
}

// LLM root-cause analysis for one product. Throws on rate limits so the workflow retries with backoff.
export async function rootCauseForSkuCore(sku, notes, stats, env = process.env) {
  if (!env.GROQ_API_KEY) return { sku, problem: "AI key not configured on this service", evidence_quotes: [], recommendation: "", stats };
  const base = env.GROQ_BASE || "https://api.groq.com/openai/v1";
  const call = (model) => fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You analyse refund notes for one product of a small online shop. Reply with JSON only: {\"problem\": string (the recurring root cause, under 12 words), \"evidence_quotes\": string[] (2-4 notes quoted exactly as written), \"recommendation\": string (one concrete fix, under 25 words)}." },
        { role: "user", content: JSON.stringify({ sku, refund_rate: stats?.refund_rate, times_shop_average: stats?.vs_shop, refund_notes: notes }) },
      ],
    }),
  });
  let r = await call(env.GROQ_MODEL || "openai/gpt-oss-120b");
  let j = await r.json().catch(() => ({}));
  // Daily quota exhausted on the primary model: use the fallback model (separate quota) instead of failing.
  if (r.status === 429 && /per day|(TPD)|(RPD)/i.test(j?.error?.message || "")) {
    r = await call(env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-20b");
    j = await r.json().catch(() => ({}));
  }
  if (r.status === 429 || r.status >= 500) throw new Error(`Groq ${r.status}: retrying`);
  if (!r.ok) throw new Error(`Groq ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  let out;
  try { out = JSON.parse(j.choices[0].message.content); } catch { throw new Error("Model returned invalid JSON: retrying"); }
  const lower = notes.map((n) => n.toLowerCase());
  const quotes = (Array.isArray(out.evidence_quotes) ? out.evidence_quotes : [])
    .map(String)
    .filter((q) => lower.some((n) => n.includes(q.toLowerCase().replace(/^["']|["']$/g, ""))));
  return { sku, problem: String(out.problem || ""), evidence_quotes: quotes, recommendation: String(out.recommendation || ""), stats };
}
