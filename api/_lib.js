// Shared server-side helpers. Secrets live ONLY here (Vercel env vars), never in the browser.
const crypto = require("crypto");

const FASTN_API = (process.env.FASTN_API_URL || "https://api.fastn.dev").replace(/\/+$/, "");
// Path prefix in front of every endpoint (the dashboard embed snippet uses /v1).
const PREFIX = process.env.FASTN_API_PREFIX ?? "/v1";
const API_KEY = process.env.FASTN_API_KEY || "";
const IDV_SECRET = process.env.FASTN_IDV_SECRET || "";
const WORKFLOW = process.env.FASTN_WORKFLOW || "facilityflow-core";
const ADMIN_PIN = process.env.ADMIN_PIN || "admin123";

// Each university is a Fastn tenant (end_org). `ref` is OUR id for the customer,
// `fastnId` is the tenant id Fastn generated. Override with TENANTS_JSON if needed.
const TENANTS = process.env.TENANTS_JSON
  ? JSON.parse(process.env.TENANTS_JSON)
  : {
      nutech: { name: "NUTECH Islamabad", fastnId: "b9286270-d694-4f3c-a79d-569babfc46c2", accent: "#0b6e4f" },
      riverside: { name: "Riverside University", fastnId: "e4ad9608-cde1-4961-9b81-6b0d646044c2", accent: "#1d4ed8" },
    };

function tenantOr404(ref, res) {
  const t = TENANTS[String(ref || "")];
  if (!t) { res.status(404).json({ error: "Unknown organisation" }); return null; }
  return { ref, ...t };
}

function identityHeaders(customerRef, userId) {
  const h = { "content-type": "application/json", "x-api-key": API_KEY, "x-org-id": customerRef, "x-user-id": userId };
  // A Fastn "Test" mode key is refused unless this header is sent.
  if ((process.env.FASTN_KEY_MODE || "test") === "test") h["x-fastn-test-mode"] = "true";
  if (IDV_SECRET) {
    h["x-identity-hmac"] = crypto.createHmac("sha256", IDV_SECRET).update(`${customerRef}\n${userId}`).digest("hex");
  }
  return h;
}

async function readJson(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// Run the multi-tenant workflow AS the given tenant: Fastn resolves that tenant's own
// connections (Gmail, Sheets, Drive, Calendar, Telegram) and the workflow scopes rows to it.
async function runWorkflow(tenant, userId, input) {
  const headers = { ...identityHeaders(tenant.ref, userId), "x-end-org-id": tenant.fastnId };
  const r = await fetch(`${FASTN_API}${PREFIX}/workflows/${encodeURIComponent(WORKFLOW)}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { ...input, tenant: tenant.fastnId } }),
  });
  const body = await readJson(r);
  if (!r.ok) {
    const msg = (body && (body.error && (body.error.message || body.error)) || body.message || body.raw) || `HTTP ${r.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = r.status;
    err.details = body;
    throw err;
  }
  return body && body.data !== undefined ? body.data : body;
}

async function embedToken(tenant, userId) {
  const r = await fetch(`${FASTN_API}${PREFIX}/embed/token`, {
    method: "POST",
    headers: identityHeaders(tenant.ref, userId),
    body: JSON.stringify({}),
  });
  const body = await readJson(r);
  if (!r.ok) {
    const err = new Error((body && (body.error && (body.error.message || body.error)) || body.message) || `HTTP ${r.status}`);
    err.status = r.status; err.details = body; throw err;
  }
  const d = body.data || body;
  return d.token || d.embedToken || d.accessToken;
}

function checkAdmin(req, res) {
  const pin = req.headers["x-admin-pin"] || "";
  if (pin !== ADMIN_PIN) { res.status(401).json({ error: "Admin PIN required" }); return false; }
  return true;
}

module.exports = { FASTN_API, PREFIX, TENANTS, tenantOr404, runWorkflow, embedToken, checkAdmin };
