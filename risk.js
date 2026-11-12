// Deterministic, explainable hold-risk engine. CODE decides scores and allowed fixes; the AI model only explains them.
// This is a transparent heuristic built from public PayPal guidance. It is NOT PayPal's internal risk model.

export const RULES = [
  { id: "UNSHIPPED_LATE", source: "Your shipping export", points: 30, label: "Not shipped after 7+ days (likely 'item not received' dispute)" },
  { id: "UNSHIPPED", source: "Your shipping export", points: 15, label: "Not shipped yet after 2+ days" },
  { id: "NO_TRACKING", source: "PayPal (live) + your export", points: 25, label: "Shipped, but no tracking on the PayPal transaction" },
  { id: "HIGH_TICKET", source: "PayPal (live)", points: 20, label: "Order is more than 2× your median order value" },
  { id: "SALES_SPIKE_EXTREME", source: "PayPal orders + simulated history", points: 25, label: "Sales are more than 4× your 30-day baseline" },
  { id: "SALES_SPIKE", source: "PayPal orders + simulated history", points: 15, label: "Recent sales are more than 2× your 30-day baseline" },
  { id: "SKU_REFUNDS", source: "Simulated history", points: 15, label: "This product's refund rate is more than 2× your shop average" },
  { id: "DISPUTE_RATE", source: "Simulated history", points: 10, label: "Your dispute rate is above 1%" },
  { id: "NEW_ACCOUNT", source: "Simulated history", points: 10, label: "Account is younger than 90 days" },
];
const RULE = Object.fromEntries(RULES.map((r) => [r.id, r]));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function skuStats(history) {
  const refundsBySku = {};
  for (const r of history.refunds_30d) refundsBySku[r.sku] = (refundsBySku[r.sku] || 0) + 1;
  const totalRefunds = history.refunds_30d.length;
  const shopRate = totalRefunds / history.orders_30d;
  const stats = {};
  for (const [sku, n] of Object.entries(history.sku_orders_30d)) {
    const refunds = refundsBySku[sku] || 0;
    const rate = n ? refunds / n : 0;
    stats[sku] = { orders: n, refunds, refund_rate: +rate.toFixed(3), vs_shop: shopRate ? +(rate / shopRate).toFixed(1) : 0 };
  }
  return { shopRate: +shopRate.toFixed(3), stats };
}

/**
 * @param orders  [{orderId, captureId, item, sku, amount, shipped, carrier, tracking, daysAgo, trackersOnPayPal, refunded}]
 * @param history data/history.json
 */
export function assess(orders, history, overrides = {}) {
  const amounts = orders.map((o) => Number(o.amount));
  const med = median(amounts);
  const recentSales = orders.filter((o) => o.daysAgo <= 3).reduce((s, o) => s + Number(o.amount), 0);
  const spikeRatio = overrides.spikeRatio ?? +(recentSales / (history.baseline_daily_sales_usd * 3)).toFixed(1);
  const { shopRate, stats } = skuStats(history);
  const disputeRate = history.disputes_30d / history.orders_30d;

  const scored = orders.map((o) => {
    const fired = [];
    if (o.refunded) return { ...o, risk: 0, level: "resolved", factors: [], fix: null };
    if (!o.shipped && o.daysAgo >= 7) fired.push("UNSHIPPED_LATE");
    else if (!o.shipped && o.daysAgo >= 2) fired.push("UNSHIPPED");
    if (o.shipped && !(o.trackersOnPayPal?.length)) fired.push("NO_TRACKING");
    if (Number(o.amount) > 2 * med) fired.push("HIGH_TICKET");
    if (spikeRatio > 4) fired.push("SALES_SPIKE_EXTREME");
    else if (spikeRatio > 2) fired.push("SALES_SPIKE");
    // Needs a minimum sample (3+ refunds) so one refund on a small product isn't flagged as a pattern.
    if ((stats[o.sku]?.vs_shop || 0) > 2 && (stats[o.sku]?.refunds || 0) >= 3) fired.push("SKU_REFUNDS");
    if (disputeRate > 0.01) fired.push("DISPUTE_RATE");
    if (history.account_age_days < 90) fired.push("NEW_ACCOUNT");

    const risk = Math.min(100, fired.reduce((s, id) => s + RULE[id].points, 0));
    // The ONLY fixes the agent is allowed to execute or propose, decided here in code:
    let fix = null;
    if (fired.includes("NO_TRACKING") && o.tracking) fix = { type: "UPLOAD_TRACKING", carrier: o.carrier, tracking_number: o.tracking };
    else if (fired.includes("UNSHIPPED_LATE")) fix = { type: "REFUND", amount: Number(o.amount).toFixed(2) };
    return {
      ...o,
      risk,
      level: risk >= 60 ? "high" : risk >= 35 ? "medium" : "low",
      factors: fired.map((id) => ({ id, points: RULE[id].points, label: RULE[id].label, source: RULE[id].source })).sort((a, b) => b.points - a.points),
      fix,
    };
  });

  // Account-level limitation forecast (heuristic): refunds per day over the last 7 days vs a 10% refund-rate line.
  const last7 = history.refunds_30d.filter((r) => r.days_ago <= 7).length;
  const perDay = last7 / 7;
  const refunds = history.refunds_30d.length;
  const line = 0.1 * history.orders_30d;
  const daysToLine = perDay > 0 ? Math.max(0, Math.ceil((line - refunds) / perDay)) : null;
  const active = scored.filter((o) => o.level !== "resolved");
  const accountScore = Math.round(active.reduce((s, o) => s + o.risk, 0) / Math.max(1, active.length));

  return {
    orders: scored,
    account: {
      score: accountScore,
      held_total_usd: orders.filter((o) => !o.refunded).reduce((s, o) => s + Number(o.amount), 0),
      at_risk_usd: scored.filter((o) => o.level === "high").reduce((s, o) => s + Number(o.amount), 0),
      median_order_usd: med,
      spike_ratio: spikeRatio,
      dispute_rate: +disputeRate.toFixed(3),
      shop_refund_rate: shopRate,
      refunds_last_7d: last7,
      days_to_limitation_line: daysToLine,
      sku_stats: stats,
    },
  };
}

/**
 * What-if simulator: re-runs the SAME deterministic rules on a hypothetical version of the shop.
 * scenario = { uploadAllTracking, resolveLateOrders, fixSkus: ["WAX-KIT"], salesMultiplier: 1..4 }
 */
export function simulate(orders, history, scenario = {}) {
  let o2 = orders.map((o) => ({ ...o }));
  if (scenario.uploadAllTracking) o2 = o2.map((o) => (o.shipped ? { ...o, trackersOnPayPal: ["simulated"] } : o));
  if (scenario.resolveLateOrders) o2 = o2.map((o) => (!o.shipped && o.daysAgo >= 7 ? { ...o, refunded: true } : o));
  let h2 = history;
  if (scenario.fixSkus?.length) {
    // Assume the fixed product's refunds fall to one (a normal level) after the root cause is addressed.
    const keep = new Set();
    h2 = {
      ...history,
      refunds_30d: history.refunds_30d.filter((r) => {
        if (!scenario.fixSkus.includes(r.sku)) return true;
        if (keep.has(r.sku)) return false;
        keep.add(r.sku);
        return true;
      }),
    };
  }
  const base = assess(orders, history);
  const mult = Number(scenario.salesMultiplier || 1);
  const overrides = mult !== 1 ? { spikeRatio: +(base.account.spike_ratio * mult).toFixed(1) } : {};
  return assess(o2, h2, overrides);
}
