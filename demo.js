// Demo seeding for the OFFLINE MOCK PayPal mode (judges can reset the scenario from the UI).
// With real sandbox credentials, use `npm run seed` + buyer approval + `npm run seed:capture` instead.
import fs from "node:fs";
import { paypal, PAYPAL_MODE } from "./paypal.js";

export const DEMO_ORDERS = [
  { item: "Lavender candle x4", sku: "LAV-4", amount: "148.00", shipped: true, carrier: "USPS", tracking: "9400111899223197428490", daysAgo: 3 },
  { item: "Gift box deluxe", sku: "GIFT-DLX", amount: "320.00", shipped: true, carrier: "UPS", tracking: "1Z999AA10123456784", daysAgo: 2 },
  { item: "Cedar candle x2", sku: "CED-2", amount: "76.00", shipped: true, carrier: "USPS", tracking: "9400111899223197428506", daysAgo: 4 },
  { item: "Wedding favors x40", sku: "FAV-40", amount: "540.00", shipped: true, carrier: "FEDEX", tracking: "771234567890", daysAgo: 1 },
  { item: "Soy wax kit", sku: "WAX-KIT", amount: "96.00", shipped: false, daysAgo: 9 },
  { item: "Sample pack", sku: "SAMPLE", amount: "60.00", shipped: false, daysAgo: 1 },
];

export async function seedMockDemo() {
  if (PAYPAL_MODE !== "mock") throw new Error("Reset is only available in offline mock mode. With real sandbox keys, run the seed scripts.");
  fs.mkdirSync("data", { recursive: true });
  for (const f of ["data/mock-paypal.json", "data/state.json", "data/audit.jsonl"]) { try { fs.unlinkSync(f); } catch {} }
  const done = [];
  for (const [i, o] of DEMO_ORDERS.entries()) {
    const order = await paypal.createOrder(o.amount, o.item, `UNHOLD-${Date.now()}-${i}`);
    const cap = await paypal.captureOrder(order.id);
    done.push({ ...o, orderId: order.id, captureId: cap.purchase_units[0].payments.captures[0].id, captureStatus: "COMPLETED" });
  }
  fs.writeFileSync("data/orders.json", JSON.stringify(done, null, 2));
  const csv = ["order_id,item,sku,shipped,carrier,tracking_number,order_age_days"]
    .concat(done.map((o) => [o.orderId, o.item, o.sku, o.shipped, o.carrier || "", o.tracking || "", o.daysAgo].join(",")))
    .join("\n");
  fs.writeFileSync("data/fulfillment.csv", csv);
  return done.length;
}

export async function ensureDemoData() {
  if (PAYPAL_MODE === "mock" && (!fs.existsSync("data/orders.json") || !fs.existsSync("data/mock-paypal.json"))) {
    const n = await seedMockDemo();
    console.log(`Seeded offline demo shop with ${n} orders.`);
  }
}
