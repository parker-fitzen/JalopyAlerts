# Alert Scheduling & Cloudflare Configuration

This document explains how to provision the alert worker, its storage bindings, and the environment needed so both the scheduled worker and Pages Functions can send notifications reliably.

## Daily cron trigger
- **Schedule:** `0 9 * * *` (09:00 UTC) runs the alert sweep once per day.
- **Local alignment:** 09:00 UTC aligns with **2:00 a.m. MST**. Keep this in mind when coordinating maintenance windows or monitoring windows.
- **Wrangler snippet:**
  ```toml
  [triggers]
  crons = ["0 9 * * *"]
  ```
  The worker already guards against mismatched cron expressions in code, so stay consistent when updating `wrangler.toml`.

## Wrangler configuration
- **Entry:** `main = "worker.js"` with `compatibility_date = "2024-08-01"` to match the current deployment.
- **Routing:**
  - For Pages, mount the worker on the same zone and route `/alerts*` to the worker (or co-locate logic in Pages Functions) so the frontend can reach the alerts endpoints without extra CORS hops.
  - If you keep a standalone Worker, add a route such as `route = "example.com/alerts*"` under a `[routes]` block or use `routes = [ { pattern = "example.com/alerts*", zone_id = "..." } ]`.
- **Bindings (choose names that match the code or update `getSearchStore`):**
  - **KV:** `binding = "ALERTS"` (preferred) or `binding = "SAVED_SEARCHES"` for the saved-search registry.
  - **D1 (optional):** `binding = "ALERT_EVENTS"` for durable alert/audit history if you introduce relational storage.
  - **R2 (optional):** `binding = "ALERT_PAYLOADS"` for archiving payloads or large artifacts that exceed KV limits.
- **Local dev defaults:** mirror the above bindings under the `[vars]` and `[env.dev]` sections to avoid divergent names between preview and production.

## Environment variables and secrets
These values must be available to **both** the scheduled Worker and any Pages Functions that emit notifications.

| Purpose | Example name | Notes |
| --- | --- | --- |
| From-address for email | `ALERT_EMAIL_FROM` | Mail-from or sender identity. |
| SMTP/Email auth key | `ALERT_EMAIL_API_KEY` | Keep in `wrangler secret` so previews also work. |
| Push service key | `ALERT_PUSH_API_KEY` | Use the provider key for push notifications. |
| VAPID public key | `VAPID_PUBLIC_KEY` | Required if using Web Push. |
| VAPID private key | `VAPID_PRIVATE_KEY` | Keep secret; pair with the public key. |
| Optional signing salt | `ALERT_SIGNING_SECRET` | For verifying subscription requests. |

### Attaching secrets
- **Workers:** run `wrangler secret put <NAME>` for each secret. Ensure the values exist in every environment (`--env production`, `--env preview`, etc.).
- **Pages Functions:** add the same secrets in the Pages project dashboard or via `wrangler secret put --env production <NAME>` inside the Pages repo so Functions see them at runtime.
- **Plain variables:** add non-secret values (e.g., email from address) under `[vars]` in `wrangler.toml` and mirror them in Pages project settings.

## Storage bindings
- **KV:** Create a KV namespace (e.g., `jalopyalerts-saved-searches`) and attach it as `ALERTS` or `SAVED_SEARCHES` in `wrangler.toml`:
  ```toml
  [[kv_namespaces]]
  binding = "ALERTS"
  id = "<prod-namespace-id>"
  preview_id = "<preview-namespace-id>"
  ```
- **D1 (optional):**
  ```toml
  [[d1_databases]]
  binding = "ALERT_EVENTS"
  database_name = "jalopyalerts-events"
  database_id = "<uuid>"
  preview_database_id = "<uuid>"
  ```
- **R2 (optional):**
  ```toml
  [[r2_buckets]]
  binding = "ALERT_PAYLOADS"
  bucket_name = "jalopyalerts-payloads"
  preview_bucket_name = "jalopyalerts-payloads-preview"
  ```

## Routing and CORS
- The Worker sets permissive CORS headers today; tighten to your domain by setting `Access-Control-Allow-Origin` to your Pages hostname or zone apex when deploying.
- Prefer deploying the Worker on the same domain as the Pages site and routing `/alerts` or `/alerts/*` to it. That keeps browser calls same-origin and avoids preflight failures.
- If you expose the Worker on a different host, configure `Access-Control-Allow-Origin` to include the Pages origin and ensure `Access-Control-Allow-Headers` contains `Content-Type` for JSON/POST calls.

## Local testing
- **Pages + Functions:** run `wrangler pages dev` from the repo root to serve the static frontend and Functions. Use `--binding` flags to inject KV/D1/R2 bindings and `--local` or `--persist-to` to keep KV data between runs.
- **Scheduled Worker:** run `wrangler dev --test-scheduled` inside `worker/` (or with `--config worker/wrangler.toml`) to invoke the cron handler locally. Combine with `--env` to mirror production bindings and secrets.
- **Manual fetch:** `wrangler dev` will also expose the `/alerts` endpoints for manual curl tests; keep routes consistent with production patterns.

## Operational notes
- Keep the cron expression at `0 9 * * *` so the sweep remains aligned with **2:00 a.m. MST** operations.
- When updating bindings or secrets, update both the scheduled Worker and Pages Functions to avoid mismatched environments.
- If you rename the KV binding, also update `getSearchStore` in `worker.js` to keep the scheduled job writing to the correct namespace.
