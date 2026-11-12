// Seeds the PayPal SANDBOX with a realistic scenario for a small candle shop.
//   node seed.js create   → creates real sandbox orders and prints approval links (approve each as the sandbox BUYER)
//   node seed.js capture  → captures approved orders, writes data/orders.json + data/fulfillment.csv
import fs from "node:fs";
import { paypal, PAYPAL_MODE } from "./paypal.js";

const ORDERS = [
  { item: "Lavender candle x4", sku: "LAV-4", amount: "148.00", shipped: true, carrier: "USPS", tracking: "9400111899223197428490", daysAgo: 3 },
  { item: "Gift box deluxe", sku: "GIFT-DLX", amount: "320.00", shipped: true, carrier: "UPS", tracking: "1Z999AA10123456784", daysAgo: 2 },
  { item: "Cedar candle x2", sku: "CED-2", amount: "76.00", shipped: true, carrier: "USPS", tracking: "9400111899223197428506", daysAgo: 4 },
  { item: "Wedding favors x40", sku: "FAV-40", amount: "540.00", shipped: true, carrier: "FEDEX", tracking: "771234567890", daysAgo: 1 },
  { item: "Soy wax kit", sku: "WAX-KIT", amount: "96.00", shipped: false, daysAgo: 9 },
  { item: "Sample pack", sku: "SAMPLE", amount: "60.00", shipped: false, daysAgo: 1 },
];

fs.mkdirSync("data", { recursive: true });
const mode = process.argv[2];

if (mode === "create") {
  const created = [];
  for (const [i, o] of ORDERS.entries()) {
    const order = await paypal.createOrder(o.amount, o.item, `UNHOLD-${Date.now()}-${i}`);
    const approve = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    created.push({ ...o, orderId: order.id });
    console.log(`${o.item.padEnd(22)} $${o.amount.padStart(7)}  approve → ${approve}`);
  }
  fs.writeFileSync("data/pending.json", JSON.stringify(created, null, 2));
  console.log("\nOpen each link, log in as your sandbox PERSONAL account, approve. Then: npm run seed:capture");
} else if (mode === "capture") {
  const pending = JSON.parse(fs.readFileSync("data/pending.json", "utf8"));
  const done = [];
  for (const o of pending) {
    try {
      const cap = await paypal.captureOrder(o.orderId);
      const capture = cap.purchase_units[0].payments.captures[0];
      done.push({ ...o, captureId: capture.id, captureStatus: capture.status });
      console.log(`captured ${o.orderId} → ${capture.id} (${capture.status})`);
    } catch (e) {
      console.log(`skip ${o.orderId}: ${e.message.slice(0, 160)}`);
    }
  }
  fs.writeFileSync("data/orders.json", JSON.stringify(done, null, 2));
  // The seller's fulfillment export: what their shipping tool knows but PayPal doesn't yet.
  const csv = ["order_id,item,sku,shipped,carrier,tracking_number,order_age_days"]
    .concat(done.map((o) => [o.orderId, o.item, o.sku, o.shipped, o.carrier || "", o.tracking || "", o.daysAgo].join(",")))
    .join("\n");
  fs.writeFileSync("data/fulfillment.csv", csv);
  for (const f of ["data/state.json", "data/audit.jsonl"]) { try { fs.unlinkSync(f); } catch {} }
  console.log(`\nWrote data/orders.json (${done.length}) and data/fulfillment.csv`);
} else {
  console.log("usage: node seed.js create | capture");
}
