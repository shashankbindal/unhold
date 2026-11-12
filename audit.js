// Append-only audit log: every proposal, approval and PayPal call, with a hash of the exact payload.
import fs from "node:fs";
import crypto from "node:crypto";

const FILE = "data/audit.jsonl";

export const hash = (obj) => crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");

export function audit(actor, action, payload, result = {}) {
  const entry = { at: new Date().toISOString(), actor, action, payload_sha256: hash(payload), payload, result };
  fs.mkdirSync("data", { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(entry) + "\n");
  return entry;
}

export function readAudit() {
  try {
    return fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
