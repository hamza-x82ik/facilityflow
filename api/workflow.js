// POST /api/workflow  { org, action, ...payload }
// Students may only "report". Everything else needs the admin PIN.
const { tenantOr404, runWorkflow, checkAdmin } = require("./_lib");

const PUBLIC_ACTIONS = new Set(["report"]);
const ADMIN_ACTIONS = new Set(["list", "get", "resolve", "remind", "getSettings", "saveSettings", "detectTelegram"]);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const tenant = tenantOr404(body.org, res);
  if (!tenant) return;
  const action = String(body.action || "");
  if (!PUBLIC_ACTIONS.has(action) && !ADMIN_ACTIONS.has(action)) return res.status(400).json({ error: "Unknown action" });
  if (ADMIN_ACTIONS.has(action) && !checkAdmin(req, res)) return;

  const { org, ...input } = body;
  const userId = action === "report" ? "student" : "facilities-admin";
  try {
    const data = await runWorkflow(tenant, `${tenant.ref}-${userId}`, input);
    res.status(200).json({ ok: true, data });
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 500).json({ ok: false, error: e.message, details: e.details || null });
  }
};
