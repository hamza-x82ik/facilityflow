// POST /api/embed-token { org }  -> { iframeUrl }
// Mints a tenant-scoped Fastn embed token so the university admin connects THEIR OWN accounts.
const { FASTN_API, PREFIX, tenantOr404, embedToken, checkAdmin } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!checkAdmin(req, res)) return;
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const tenant = tenantOr404(body.org, res);
  if (!tenant) return;
  try {
    const token = await embedToken(tenant, `${tenant.ref}-facilities-admin`);
    if (!token) throw new Error("Fastn returned no embed token");
    res.status(200).json({ ok: true, iframeUrl: `${FASTN_API}${PREFIX}/embed/iframe?token=${encodeURIComponent(token)}` });
  } catch (e) {
    res.status(e.status && e.status < 600 ? e.status : 500).json({ ok: false, error: e.message, details: e.details || null });
  }
};
