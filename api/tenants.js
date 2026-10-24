// GET /api/tenants -> public list of organisations (no secrets, no Fastn ids).
const { TENANTS } = require("./_lib");

module.exports = (req, res) => {
  res.status(200).json({
    tenants: Object.entries(TENANTS).map(([ref, t]) => ({ ref, name: t.name, accent: t.accent || "#0b6e4f" })),
  });
};
