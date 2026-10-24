# FacilityFlow

**Campus problems, routed to the people who fix them.**

FacilityFlow is a multi-tenant maintenance and incident platform for universities and facilities-management companies. Students report a water leak, a dead light or an overflowing bin with a photo. FacilityFlow classifies it, counts repeat reports, escalates to **URGENT** after a threshold (default 5), notifies the facilities team in the tools that organisation already uses, books a repair visit, and keeps sending reminders until someone uploads **photo proof** that it is fixed.

Each university is a separate customer (tenant). Each one connects **its own** Gmail, Google Sheets, Google Drive, Google Calendar and Telegram through a Fastn connect panel embedded inside FacilityFlow. Data and connections never cross between tenants.

## The problem
Campus complaints are scattered across WhatsApp groups, emails and verbal reports. Nobody knows which issues are recurring, which are urgent, or whether anything was actually fixed.

## Who the customer is
University estates/facilities departments and facilities-management companies. Students are the reporters; the facilities admin is the customer who sets up FacilityFlow and connects the organisation's tools.

## How customers connect their accounts
1. The facilities admin opens **Facilities admin → Connect your tools**.
2. The page loads the Fastn widget in an iframe using a **tenant-scoped embed token** minted by our backend (API key + HMAC identity verification, never exposed to the browser).
3. The admin signs into their own Google account and pastes their own Telegram bot token. Fastn stores the credentials against that tenant only.

## Integrations (5)
| Connector | What FacilityFlow does with it |
|---|---|
| Gmail | Emails the right department for new, escalated, resolved issues and reminders |
| Google Sheets | Auto-creates an incident log sheet per tenant and appends every event |
| Google Drive | Stores report photos and resolution proof as shareable files |
| Google Calendar | Books a repair visit when an issue escalates to urgent |
| Telegram Bot | Instant alerts to the facilities team chat (chat auto-detected) |

## How Fastn is used
- **Workflow `facilityflow-core`** (published): one multi-tenant workflow with actions `report`, `list`, `get`, `resolve`, `remind`, `getSettings`, `saveSettings`, `detectTelegram`. Duplicate detection, escalation, proof enforcement and reminder logic live here. Every connector call is isolated so one failing app never blocks the others, and the per-app result is shown to the user.
- **Connector manifest**: all 5 connectors set to `MULTI_TENANT`, so each run resolves the calling tenant's own connection.
- **Tenants**: `NUTECH Islamabad` and `Riverside University` created as Fastn end-orgs.
- **Widget `FacilityFlow Integrations`** bundles the 5 connectors + workflow and is embedded in our admin UI.
- **Schedulers**: hourly reminder trigger per tenant; reminders stop automatically once an incident is resolved with proof.
- Built with Claude through the **Fastn MCP** (tenants, workflow, manifest, widget and schedulers all created from the agent).

## Two-tenant test
1. Open the app → NUTECH → Facilities admin → Connect your tools → connect account A.
2. Open Riverside → Connect your tools → connect account B.
3. Submit the same report from both student pages.
4. NUTECH's email/sheet/Drive/Telegram receive only NUTECH's incident; Riverside's only Riverside's. Each dashboard lists only its own incidents.

## Run / deploy
No build step. Static `index.html` + Vercel serverless functions in `/api`.

1. Import this repo into Vercel.
2. Set environment variables (see `.env.example`): `FASTN_API_URL`, `FASTN_API_KEY`, `FASTN_IDV_SECRET`, `FASTN_WORKFLOW`, `ADMIN_PIN`.
3. Deploy. Demo admin PIN for judges: set in `ADMIN_PIN`.

`fastn/facilityflow-core.js` holds the workflow source.

## What's next
Short video proof uploads, AI photo classification, QR codes on each room for one-tap reporting, SLA analytics, and more connectors (Slack, Microsoft Teams, Jira) for organisations not on Google.
