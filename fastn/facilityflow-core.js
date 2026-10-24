// FacilityFlow core workflow (multi-tenant).
// One workflow, routed by ctx.input.action:
//   report | list | resolve | remind | getSettings | saveSettings | detectTelegram
// Every tenant (university) runs this against ITS OWN connected accounts
// (Gmail, Google Sheets, Google Drive, Google Calendar, Telegram) and ITS OWN rows.

const ff = new Fastn({
  connectors: {
    googleGmail: { orgId: "managed" },
    googleSheets: { orgId: "managed" },
    googleDrive: { orgId: "managed" },
    googleCalendar: { orgId: "managed" },
    telegramBot: { orgId: "managed" },
  },
});

const DEFAULTS = {
  universityName: "",
  adminEmail: "",
  deptEmails: {},            // { plumbing: "x@uni.edu", electrical: "...", ... }
  telegramChatId: "",
  spreadsheetId: "",
  escalationThreshold: 5,    // same issue reported N times -> URGENT
  reminderIntervalMinutes: 4320, // 3 days (set low for demos)
  timeZone: "Asia/Karachi",
};

const HIGH_CATEGORIES = ["water leak", "electrical hazard", "fire safety", "gas leak"];

// ---------- helpers ----------
function tenantOf(ctx) {
  const h = ctx.headers || {};
  // Prefer the tenant baked into the verified JWT; fall back to the routed header, then input (dev only).
  const jwtTenant = h["x-jwt-end-org-id"] && h["x-jwt-end-org-id"] !== h["x-jwt-org-id"] ? h["x-jwt-end-org-id"] : null;
  const t = jwtTenant || h["x-end-org-id"] || (ctx.input || {}).tenant;
  if (!t) throw new Error("Missing tenant (x-end-org-id or input.tenant)");
  return String(t);
}

function newId() {
  return "FF-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
}

function norm(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function b64url(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += A[b0 >> 2] + A[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
    if (b1 !== undefined) out += A[((b1 & 15) << 2) | ((b2 || 0) >> 6)];
    if (b2 !== undefined) out += A[b2 & 63];
  }
  return out;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function ensureTables() {
  await fastn.db.query(`CREATE TABLE IF NOT EXISTS ff_incidents (
    id TEXT PRIMARY KEY, tenant TEXT NOT NULL, category TEXT, location TEXT, location_key TEXT,
    description TEXT, reporter TEXT, reporters JSONB DEFAULT '[]'::jsonb, priority TEXT, status TEXT,
    report_count INT DEFAULT 1, photo TEXT, proof_photo TEXT, proof_note TEXT, resolved_by TEXT,
    drive_link TEXT, proof_drive_link TEXT, calendar_event_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
    escalated_at TIMESTAMPTZ, last_reminder_at TIMESTAMPTZ, reminders_sent INT DEFAULT 0, resolved_at TIMESTAMPTZ)`);
  await fastn.db.query(`CREATE TABLE IF NOT EXISTS ff_settings (tenant TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT now())`);
}

async function getSettings(tenant) {
  const r = await fastn.db.query("SELECT data FROM ff_settings WHERE tenant = $1", [tenant]);
  const rows = r.rows || r;
  const saved = rows && rows[0] ? rows[0].data || {} : {};
  return { ...DEFAULTS, ...saved, deptEmails: { ...(saved.deptEmails || {}) } };
}

async function saveSettings(tenant, data) {
  await fastn.db.query(
    `INSERT INTO ff_settings (tenant, data, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (tenant) DO UPDATE SET data = $2::jsonb, updated_at = now()`,
    [tenant, JSON.stringify(data)]
  );
}

function rowsOf(r) { return (r && (r.rows || r)) || []; }

// Each integration call is isolated: one failing app never blocks the others.
async function step(results, app, label, fn) {
  try {
    const out = await fn();
    if (out === null) { results.push({ app, label, ok: false, skipped: true, detail: "not configured" }); return null; }
    results.push({ app, label, ok: true });
    return out;
  } catch (e) {
    results.push({ app, label, ok: false, detail: String((e && e.message) || e).slice(0, 300) });
    return null;
  }
}

// ---------- integrations ----------
async function sendEmail(to, subject, html) {
  if (!to) return null;
  const msg = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\r\n");
  const r = await ff.connector.googleGmail.sendMessage({ raw: b64url(msg) });
  return r.output || true;
}

async function sendTelegram(s, text) {
  if (!s.telegramChatId) return null;
  const r = await ff.connector.telegramBot.sendMessage({ chat_id: String(s.telegramChatId), text, parse_mode: "HTML" });
  return r.output || true;
}

async function ensureSheet(tenant, s) {
  if (s.spreadsheetId) return s.spreadsheetId;
  const r = await ff.connector.googleSheets.createSpreadsheet({ title: `FacilityFlow Incident Log - ${s.universityName || tenant}` });
  const id = (r.output && (r.output.spreadsheetId || r.output.id)) || null;
  if (!id) throw new Error("createSpreadsheet returned no id");
  await ff.connector.googleSheets.appendValues({
    spreadsheetId: id, range: "A1", valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    values: [["Timestamp", "Event", "Incident ID", "Category", "Location", "Priority", "Status", "Report count", "Reporter / Resolver", "Description / Note", "Drive proof"]],
  });
  s.spreadsheetId = id;
  await saveSettings(tenant, s);
  return id;
}

async function logSheet(tenant, s, event, inc, who, note, link) {
  const id = await ensureSheet(tenant, s);
  await ff.connector.googleSheets.appendValues({
    spreadsheetId: id, range: "A1", valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS",
    values: [[new Date().toISOString(), event, inc.id, inc.category, inc.location, String(inc.priority).toUpperCase(), inc.status, inc.report_count, who || "", note || "", link || ""]],
  });
  return { spreadsheetId: id };
}

async function uploadProof(inc, kind, photoDataUrl, note) {
  if (!photoDataUrl) return null;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inc.id)} ${esc(kind)}</title></head>
<body style="font-family:sans-serif;max-width:720px;margin:24px auto">
<h2>FacilityFlow - ${esc(kind)} for ${esc(inc.id)}</h2>
<p><b>Category:</b> ${esc(inc.category)}<br><b>Location:</b> ${esc(inc.location)}<br><b>Priority:</b> ${esc(String(inc.priority).toUpperCase())}<br>
<b>Recorded:</b> ${new Date().toISOString()}</p>
${note ? `<p><b>Note:</b> ${esc(note)}</p>` : ""}
<img src="${photoDataUrl}" style="max-width:100%;border-radius:8px" alt="proof photo">
</body></html>`;
  const up = await ff.connector.googleDrive.uploadFile({
    name: `${inc.id}-${kind.toLowerCase().replace(/\s+/g, "-")}.html`, content: html, mimeType: "text/html", parentId: "root",
  });
  const fileId = up.output && up.output.id;
  if (!fileId) throw new Error("Drive upload returned no id");
  try { await ff.connector.googleDrive.createPermission({ fileId, type: "anyone", role: "reader" }); } catch (e) { /* link may stay private */ }
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function pad(n) { return String(n).padStart(2, "0"); }
function localIso(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`; }

async function scheduleRepair(s, inc) {
  // Book a 1-hour repair slot 2 hours from now on the facilities calendar.
  const start = new Date(Date.now() + 2 * 3600 * 1000);
  const end = new Date(start.getTime() + 3600 * 1000);
  const r = await ff.connector.googleCalendar.createEvent({
    calendarId: "primary",
    summary: `URGENT repair: ${inc.category} @ ${inc.location} (${inc.id})`,
    location: inc.location,
    description: `Reported ${inc.report_count} times via FacilityFlow.\n${inc.description || ""}`,
    startDateTime: localIso(start), endDateTime: localIso(end), timeZone: "UTC",
  });
  return (r.output && r.output.id) || true;
}

function deptEmail(s, category) {
  const key = norm(category);
  for (const [k, v] of Object.entries(s.deptEmails || {})) if (norm(k) === key && v) return v;
  return s.adminEmail;
}

function initialPriority(category) {
  return HIGH_CATEGORIES.includes(norm(category)) ? "high" : "normal";
}

function publicIncident(r, withPhotos) {
  const o = { ...r, reporters: r.reporters || [] };
  if (!withPhotos) { o.has_photo = !!r.photo; o.has_proof = !!r.proof_photo; delete o.photo; delete o.proof_photo; }
  return o;
}

// ---------- actions ----------
async function report(tenant, input) {
  const category = String(input.category || "").trim();
  const location = String(input.location || "").trim();
  if (!category || !location) throw new Error("category and location are required");
  const s = await getSettings(tenant);
  const results = [];
  const reporter = String(input.reporter || "Anonymous student").slice(0, 120);
  const description = String(input.description || "").slice(0, 2000);
  const locKey = norm(location);

  const existing = rowsOf(await fastn.db.query(
    `SELECT * FROM ff_incidents WHERE tenant = $1 AND lower(category) = $2 AND location_key = $3 AND status <> 'resolved'
     ORDER BY created_at ASC LIMIT 1`, [tenant, norm(category), locKey]))[0];

  if (existing) {
    // Duplicate report: count it, escalate when threshold reached.
    const count = (existing.report_count || 1) + 1;
    const reporters = [...(existing.reporters || []), { name: reporter, at: new Date().toISOString(), note: description }];
    const willEscalate = count >= Number(s.escalationThreshold || 5) && existing.priority !== "urgent";
    const priority = willEscalate ? "urgent" : existing.priority;
    const upd = rowsOf(await fastn.db.query(
      `UPDATE ff_incidents SET report_count = $2, reporters = $3::jsonb, priority = $4, updated_at = now(),
         escalated_at = CASE WHEN $5 THEN now() ELSE escalated_at END,
         photo = COALESCE(photo, $6)
       WHERE id = $1 AND tenant = $7 RETURNING *`,
      [existing.id, count, JSON.stringify(reporters), priority, willEscalate, input.photo || null, tenant]))[0];

    if (willEscalate) {
      const link = upd.drive_link || "";
      await step(results, "Gmail", "Escalation email to department", () => sendEmail(deptEmail(s, upd.category),
        `[URGENT] ${upd.category} at ${upd.location} reported ${count} times (${upd.id})`,
        `<h2 style="color:#b42318">Escalated to URGENT</h2><p>This issue has now been reported <b>${count} times</b> and is still unresolved.</p>
         <p><b>Category:</b> ${esc(upd.category)}<br><b>Location:</b> ${esc(upd.location)}<br><b>First reported:</b> ${esc(upd.created_at)}</p>
         <p>${esc(upd.description)}</p>${link ? `<p><a href="${link}">Photo proof</a></p>` : ""}
         <p>You will receive reminders until it is marked resolved with proof in FacilityFlow.</p>`));
      await step(results, "Telegram", "Urgent alert", () => sendTelegram(s,
        `🚨 <b>URGENT</b> ${esc(upd.category)} at ${esc(upd.location)}\nReported ${count} times - ID ${esc(upd.id)}`));
      const ev = await step(results, "Google Calendar", "Repair visit booked", () => scheduleRepair(s, upd));
      if (ev && typeof ev === "string") await fastn.db.query("UPDATE ff_incidents SET calendar_event_id = $2 WHERE id = $1 AND tenant = $3", [upd.id, ev, tenant]);
      await step(results, "Google Sheets", "Escalation logged", () => logSheet(tenant, s, "ESCALATED", upd, reporter, `Reported ${count} times`, link));
    } else {
      await step(results, "Google Sheets", "Duplicate report logged", () => logSheet(tenant, s, "DUPLICATE REPORT", upd, reporter, description, upd.drive_link));
    }
    return { outcome: willEscalate ? "escalated" : "duplicate", incident: publicIncident(upd, false), integrations: results };
  }

  // New incident.
  const inc = {
    id: newId(), tenant, category, location, location_key: locKey, description, reporter,
    priority: initialPriority(category), status: "open", report_count: 1,
  };
  const link = await step(results, "Google Drive", "Photo proof stored", () => uploadProof(inc, "Report photo", input.photo, description));
  const row = rowsOf(await fastn.db.query(
    `INSERT INTO ff_incidents (id, tenant, category, location, location_key, description, reporter, reporters, priority, status, report_count, photo, drive_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,1,$11,$12) RETURNING *`,
    [inc.id, tenant, category, location, locKey, description, reporter,
     JSON.stringify([{ name: reporter, at: new Date().toISOString(), note: description }]),
     inc.priority, "open", input.photo || null, link || null]))[0];

  await step(results, "Gmail", "Department notified", () => sendEmail(deptEmail(s, category),
    `[FacilityFlow] New ${inc.priority.toUpperCase()} ${category} at ${location} (${inc.id})`,
    `<h2>New campus issue reported</h2><p><b>Category:</b> ${esc(category)}<br><b>Location:</b> ${esc(location)}<br>
     <b>Priority:</b> ${esc(inc.priority.toUpperCase())}<br><b>Reported by:</b> ${esc(reporter)}</p><p>${esc(description)}</p>
     ${link ? `<p><a href="${link}">View photo proof</a></p>` : ""}`));
  await step(results, "Telegram", "Facilities team alerted", () => sendTelegram(s,
    `🛠 New ${esc(inc.priority.toUpperCase())} issue: <b>${esc(category)}</b> at ${esc(location)}\nID ${esc(inc.id)}${link ? `\nProof: ${link}` : ""}`));
  await step(results, "Google Sheets", "Incident logged", () => logSheet(tenant, s, "REPORTED", row, reporter, description, link));
  return { outcome: "created", incident: publicIncident(row, false), integrations: results };
}

async function list(tenant, input) {
  const rows = rowsOf(await fastn.db.query(
    `SELECT * FROM ff_incidents WHERE tenant = $1 ORDER BY
       CASE status WHEN 'resolved' THEN 1 ELSE 0 END,
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, updated_at DESC LIMIT 200`, [tenant]));
  return { incidents: rows.map((r) => publicIncident(r, !!input.withPhotos)) };
}

async function getOne(tenant, input) {
  const row = rowsOf(await fastn.db.query("SELECT * FROM ff_incidents WHERE tenant = $1 AND id = $2", [tenant, String(input.id || "")]))[0];
  if (!row) throw new Error("Incident not found for this organisation");
  return { incident: publicIncident(row, true) };
}

async function resolve(tenant, input) {
  const id = String(input.id || "");
  if (!input.proofPhoto) throw new Error("A proof photo is required to resolve an incident");
  const inc = rowsOf(await fastn.db.query("SELECT * FROM ff_incidents WHERE tenant = $1 AND id = $2", [tenant, id]))[0];
  if (!inc) throw new Error("Incident not found for this organisation");
  if (inc.status === "resolved") return { outcome: "already_resolved", incident: publicIncident(inc, false), integrations: [] };
  const s = await getSettings(tenant);
  const results = [];
  const who = String(input.resolvedBy || "Facilities team").slice(0, 120);
  const note = String(input.note || "").slice(0, 1000);
  const link = await step(results, "Google Drive", "Resolution proof stored", () => uploadProof(inc, "Resolution proof", input.proofPhoto, note));
  const row = rowsOf(await fastn.db.query(
    `UPDATE ff_incidents SET status = 'resolved', resolved_at = now(), updated_at = now(), proof_photo = $3, proof_note = $4,
       resolved_by = $5, proof_drive_link = $6 WHERE tenant = $1 AND id = $2 RETURNING *`,
    [tenant, id, input.proofPhoto, note, who, link || null]))[0];
  await step(results, "Google Sheets", "Resolution logged", () => logSheet(tenant, s, "RESOLVED", row, who, note, link));
  await step(results, "Telegram", "Team informed", () => sendTelegram(s, `✅ Resolved: <b>${esc(row.category)}</b> at ${esc(row.location)} (${esc(row.id)}) by ${esc(who)}${link ? `\nProof: ${link}` : ""}`));
  await step(results, "Gmail", "Resolution email", () => sendEmail(deptEmail(s, row.category),
    `[Resolved] ${row.category} at ${row.location} (${row.id})`,
    `<h2 style="color:#067647">Issue resolved</h2><p>${esc(row.category)} at ${esc(row.location)} was resolved by ${esc(who)}.</p>
     <p>${esc(note)}</p>${link ? `<p><a href="${link}">View resolution proof</a></p>` : ""}<p>Reminders for this issue have stopped.</p>`));
  return { outcome: "resolved", incident: publicIncident(row, false), integrations: results };
}

async function remind(tenant, input) {
  const s = await getSettings(tenant);
  const mins = Math.max(1, Number(input.intervalMinutes || s.reminderIntervalMinutes || 4320));
  const due = rowsOf(await fastn.db.query(
    `SELECT * FROM ff_incidents WHERE tenant = $1 AND priority = 'urgent' AND status <> 'resolved'
       AND COALESCE(last_reminder_at, escalated_at, created_at) <= now() - ($2::text || ' minutes')::interval
     ORDER BY created_at ASC LIMIT 50`, [tenant, String(mins)]));
  const sent = [];
  for (const inc of due) {
    const results = [];
    const n = (inc.reminders_sent || 0) + 1;
    await step(results, "Gmail", "Reminder email", () => sendEmail(deptEmail(s, inc.category),
      `[Reminder #${n}] URGENT ${inc.category} at ${inc.location} is still unresolved (${inc.id})`,
      `<h2 style="color:#b42318">Still unresolved</h2><p>${esc(inc.category)} at ${esc(inc.location)} was escalated as URGENT and has not been resolved yet.</p>
       <p>Reports: ${inc.report_count}. Upload a resolution photo in FacilityFlow to stop these reminders.</p>`));
    await step(results, "Telegram", "Reminder alert", () => sendTelegram(s, `⏰ Reminder #${n}: URGENT ${esc(inc.category)} at ${esc(inc.location)} is still unresolved (${esc(inc.id)})`));
    await fastn.db.query("UPDATE ff_incidents SET last_reminder_at = now(), reminders_sent = $3 WHERE tenant = $1 AND id = $2", [tenant, inc.id, n]);
    sent.push({ id: inc.id, reminder: n, integrations: results });
  }
  return { checked: due.length, reminded: sent.length, reminders: sent };
}

async function detectTelegram(tenant) {
  // Admin sends any message to their bot first; we read the chat id from it.
  const r = await ff.connector.telegramBot.getUpdates({ limit: 20 });
  const updates = (r.output && (r.output.result || r.output)) || [];
  const msgs = (Array.isArray(updates) ? updates : []).map((u) => u.message || u.channel_post || u.my_chat_member).filter(Boolean);
  const last = msgs[msgs.length - 1];
  if (!last || !last.chat) return { found: false, hint: "Send any message to your bot in Telegram, then try again." };
  const s = await getSettings(tenant);
  s.telegramChatId = String(last.chat.id);
  await saveSettings(tenant, s);
  await sendTelegram(s, "✅ FacilityFlow is connected. Campus alerts will arrive here.");
  return { found: true, chatId: s.telegramChatId, chatTitle: last.chat.title || last.chat.first_name || "" };
}

export default async function (ctx) {
  const input = ctx.input || {};
  const tenant = tenantOf(ctx);
  await ensureTables();
  switch (input.action) {
    case "report": return report(tenant, input);
    case "list": return list(tenant, input);
    case "get": return getOne(tenant, input);
    case "resolve": return resolve(tenant, input);
    case "remind": return remind(tenant, input);
    case "getSettings": return { settings: await getSettings(tenant) };
    case "saveSettings": {
      const cur = await getSettings(tenant);
      const allowed = ["universityName", "adminEmail", "deptEmails", "telegramChatId", "escalationThreshold", "reminderIntervalMinutes", "timeZone"];
      for (const k of allowed) if (input.settings && k in input.settings) cur[k] = input.settings[k];
      await saveSettings(tenant, cur);
      return { settings: cur };
    }
    case "detectTelegram": return detectTelegram(tenant);
    default: throw new Error(`Unknown action: ${input.action}`);
  }
}
