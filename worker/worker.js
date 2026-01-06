// Cloudflare Worker: CORS proxy + optional multi-yard aggregation + saved alerts
// NOTE: Be respectful: this multiplies upstream traffic. Add caching.

const UPSTREAM = "https://inventory.pickapartjalopyjungle.com";
// Daily alert sweep at 09:00 UTC (2:00 a.m. MST) to avoid future schedule drift.
const DAILY_ALERT_CRON = "0 9 * * *";

const SAVED_SEARCHES_KV_KEY = "saved-searches";
const MAX_ALERTS_TOTAL = 500;
const MAX_ALERTS_PER_OWNER = 25;
const ALERT_ROUTE_PREFIX = "/alerts";

const YARDS = [
  { id: "1020", name: "BOISE" },
  { id: "1021", name: "CALDWELL" },
  { id: "1119", name: "GARDEN CITY" },
  { id: "1022", name: "NAMPA" },
  { id: "1099", name: "TWIN FALLS" },
];

// Only these are forwarded upstream as-is:
const PASSTHRU_PATHS = new Set(["/", "/Home/GetMakes", "/Home/GetModels"]);

// These are handled by the worker (not forwarded):
const API_PATHS = new Set(["/api/searchAll", "/api/makesAll", "/api/modelsAll"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigin = pickAllowedOrigin(request, env);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
    }

    if (url.pathname.startsWith(ALERT_ROUTE_PREFIX)) {
      try {
        return await handleAlerts(request, env, allowedOrigin);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 500, {}, allowedOrigin);
      }
    }

    // ---- Worker-handled API endpoints ----
    if (API_PATHS.has(url.pathname)) {
      try {
        if (url.pathname === "/api/searchAll") {
          return await handleSearchAll(request, allowedOrigin);
        }
        if (url.pathname === "/api/makesAll") {
          return await handleMakesAll(request, allowedOrigin);
        }
        if (url.pathname === "/api/modelsAll") {
          return await handleModelsAll(request, allowedOrigin);
        }
        return json({ error: "Not found" }, 404, {}, allowedOrigin);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 500, {}, allowedOrigin);
      }
    }

    // ---- Passthrough proxy (locked-down) ----
    if (!PASSTHRU_PATHS.has(url.pathname)) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders(allowedOrigin) });
    }

    const target = new URL(UPSTREAM + url.pathname);
    target.search = url.search;

    const headers = new Headers(request.headers);
    headers.delete("origin");
    headers.delete("referer");

    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    const outHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(allowedOrigin))) outHeaders.set(k, v);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  },

  // Scheduled alerts refresh (runs daily at 09:00 UTC).
  async scheduled(event, env, ctx) {
    if (event.cron && event.cron !== DAILY_ALERT_CRON) return; // ignore any stale cron triggers
    ctx.waitUntil(rerunSavedSearches(env));
  },
};

async function handleSearchAll(request, allowedOrigin = "*") {
  if (request.method !== "POST") return json({ error: "POST only" }, 405, {}, allowedOrigin);

  const params = await readBodyParams(request);
  const VehicleMake = (params.VehicleMake || params.make || "").toString().trim();
  const VehicleModel = (params.VehicleModel || params.model || "").toString().trim();

  if (!VehicleMake) return json({ error: "VehicleMake is required" }, 400, {}, allowedOrigin);

  // Fan out (limit concurrency to be polite)
  const jobs = YARDS.map((y) => async () => {
    const rows = await fetchAndParseInventory({
      yardId: y.id,
      yardName: y.name,
      VehicleMake,
      VehicleModel,
    });
    return rows;
  });

  const all = await runPool(jobs, 2); // <= keep low to avoid hammering upstream

  // Flatten + sort (optional)
  const results = all.flat().sort((a, b) => {
    // group by yard, then year desc
    if (a.yardName !== b.yardName) return a.yardName.localeCompare(b.yardName);
    return (b.year ?? 0) - (a.year ?? 0);
  });

  return json(
    {
      query: { VehicleMake, VehicleModel: VehicleModel || null },
      yards: YARDS,
      count: results.length,
      results,
    },
    200,
    {
      // light caching to reduce load; tune as needed
      "Cache-Control": "public, max-age=300",
    },
    allowedOrigin
  );
}

async function handleMakesAll(request, allowedOrigin = "*") {
  if (request.method !== "POST") return json({ error: "POST only" }, 405, {}, allowedOrigin);

  const jobs = YARDS.map((y) => async () => {
    const makes = await postJsonUpstream("/Home/GetMakes", { yardId: y.id });
    // upstream returns [{ makeName: "TOYOTA" }, ...]
    return (Array.isArray(makes) ? makes : []).map((m) => (m?.makeName || "").toString()).filter(Boolean);
  });

  const lists = await runPool(jobs, 2);
  const set = new Set(lists.flat());
  const merged = Array.from(set).sort((a, b) => a.localeCompare(b));

  return json(
    { count: merged.length, makes: merged },
    200,
    { "Cache-Control": "public, max-age=3600" },
    allowedOrigin
  );
}

async function handleModelsAll(request, allowedOrigin = "*") {
  if (request.method !== "POST") return json({ error: "POST only" }, 405, {}, allowedOrigin);

  const params = await readBodyParams(request);
  const makeName = (params.makeName || params.VehicleMake || params.make || "").toString().trim();
  if (!makeName) return json({ error: "makeName is required" }, 400, {}, allowedOrigin);

  const jobs = YARDS.map((y) => async () => {
    const models = await postJsonUpstream("/Home/GetModels", { yardId: y.id, makeName });
    // upstream returns [{ model: "PRIUS" }, ...]
    return (Array.isArray(models) ? models : []).map((m) => (m?.model || "").toString()).filter(Boolean);
  });

  const lists = await runPool(jobs, 2);
  const set = new Set(lists.flat());
  const merged = Array.from(set).sort((a, b) => a.localeCompare(b));

  return json(
    { makeName, count: merged.length, models: merged },
    200,
    { "Cache-Control": "public, max-age=3600" },
    allowedOrigin
  );
}

async function fetchAndParseInventory({ yardId, yardName, VehicleMake, VehicleModel }) {
  // Cache key (POST-safe) using a synthetic GET request
  const cacheKey = new Request(
    `https://cache.local/inv?yardId=${encodeURIComponent(yardId)}&make=${encodeURIComponent(
      VehicleMake
    )}&model=${encodeURIComponent(VehicleModel || "")}`
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return await cached.json();
  }

  const form = new FormData();
  form.set("YardId", yardId);
  form.set("VehicleMake", VehicleMake);
  if (VehicleModel) form.set("VehicleModel", VehicleModel);

  const upstream = await fetch(UPSTREAM + "/", {
    method: "POST",
    body: form,
    headers: {
      // mimic a normal browser-ish accept header
      Accept: "text/html,application/xhtml+xml",
    },
  });

  const html = await upstream.text();
  const rows = parseInventoryHtml(html).map((r) => ({
    yardId,
    yardName,
    ...r,
  }));

  const resp = json(rows, 200, { "Cache-Control": "public, max-age=300" });
  await cache.put(cacheKey, resp.clone());
  return rows;
}

function parseInventoryHtml(html) {
  // Extract rows like:
  // <tr><td>2010</td><td style="font-weight:700">TOYOTA</td><td ...>PRIUS</td><td>37</td></tr>
  const out = [];
  const re =
    /<tr>\s*<td>\s*(\d{4})\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td>\s*([^<]+?)\s*<\/td>\s*<\/tr>/gim;

  for (const m of html.matchAll(re)) {
    out.push({
      year: Number(m[1]),
      make: m[2].trim(),
      model: m[3].trim(),
      row: m[4].trim(),
    });
  }
  return out;
}

async function postJsonUpstream(path, obj) {
  // jQuery on the site posts x-www-form-urlencoded (default $.ajax behavior).
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) body.set(k, String(v));

  const r = await fetch(UPSTREAM + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });

  if (!r.ok) throw new Error(`Upstream ${path} failed: ${r.status}`);
  return await r.json();
}

async function readBodyParams(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await request.json();
    return j && typeof j === "object" ? j : {};
  }
  // handles x-www-form-urlencoded and multipart/form-data
  const fd = await request.formData();
  return Object.fromEntries(fd.entries());
}

// Run tasks with limited concurrency
async function runPool(taskFns, limit) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < taskFns.length) {
      const idx = i++;
      try {
        results[idx] = await taskFns[idx]();
      } catch (e) {
        results[idx] = []; // fail closed; you can also record errors per yard
      }
    }
  }

  const n = Math.max(1, Math.min(limit, taskFns.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function json(obj, status = 200, extraHeaders = {}, allowedOrigin = "*") {
  const h = new Headers({ "Content-Type": "application/json", ...corsHeaders(allowedOrigin), ...extraHeaders });
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function corsHeaders(allowedOrigin = "*") {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

async function rerunSavedSearches(env) {
  const kv = getSearchStore(env);
  if (!kv) return;

  const saved = await kv.get(SAVED_SEARCHES_KV_KEY, { type: "json" });
  const searches = Array.isArray(saved) ? saved : [];
  if (!searches.length) return;

  const refreshed = [];

  for (const search of searches) {
    const currentRows = await runSavedSearch(search);
    const previousRows = Array.isArray(search.lastSnapshot) ? search.lastSnapshot : [];
    const newVehicles = diffNewVehicles(currentRows, previousRows);

    const next = {
      ...search,
      lastSnapshot: currentRows,
    };

    if (newVehicles.length) {
      const delivery = await deliverNotifications(search, newVehicles, env);
      next.lastNotifiedAt = new Date().toISOString();
      next.lastNotificationStatus = delivery;
    }

    refreshed.push(next);
  }

  await kv.put(SAVED_SEARCHES_KV_KEY, JSON.stringify(refreshed));
}

async function runSavedSearch(search) {
  const VehicleMake = (search?.VehicleMake || search?.make || "").toString().trim();
  const VehicleModel = (search?.VehicleModel || search?.model || "").toString().trim();
  const VehicleYear = Number(search?.VehicleYear || search?.year);

  if (!VehicleMake) return [];

  const jobs = YARDS.map((y) => async () => {
    const rows = await fetchAndParseInventory({
      yardId: y.id,
      yardName: y.name,
      VehicleMake,
      VehicleModel,
    });
    return rows;
  });

  const all = await runPool(jobs, 2);
  const flattened = all.flat();
  if (!VehicleYear || !Number.isFinite(VehicleYear)) return flattened;
  return flattened.filter((r) => Number(r.year) === VehicleYear);
}

function diffNewVehicles(current, previous) {
  const prevKeys = new Set((previous || []).map(inventoryKey));
  return (current || []).filter((row) => !prevKeys.has(inventoryKey(row)));
}

function inventoryKey(row) {
  return [row?.yardId, row?.year, row?.make, row?.model, row?.row].map((v) => String(v || "")).join(":");
}

function getSearchStore(env) {
  return env?.ALERTS || env?.SAVED_SEARCHES || null;
}

async function handleAlerts(request, env, allowedOrigin = "*") {
  const kv = getSearchStore(env);
  if (!kv) return json({ error: "KV namespace not configured" }, 500, {}, allowedOrigin);

  const ownerKey = await hashOwner(request, env);
  const url = new URL(request.url);
  const idFromPath = url.pathname.length > ALERT_ROUTE_PREFIX.length ? url.pathname.slice(ALERT_ROUTE_PREFIX.length + 1) : null;

  if (request.method === "GET") {
    const saved = await kv.get(SAVED_SEARCHES_KV_KEY, { type: "json" });
    const searches = Array.isArray(saved) ? saved : [];
    const mine = searches.filter((s) => s.ownerKey === ownerKey);
    return json({ count: mine.length, alerts: mine.map(redactSearchForClient) }, 200, {}, allowedOrigin);
  }

  if (request.method === "POST") {
    const payload = await readBodyParams(request);
    let validated;
    try {
      validated = await validateAlertPayload(payload);
    } catch (err) {
      return json({ error: String(err?.message || err) }, 400, {}, allowedOrigin);
    }

    const saved = await kv.get(SAVED_SEARCHES_KV_KEY, { type: "json" });
    const searches = Array.isArray(saved) ? saved : [];

    if (searches.length >= MAX_ALERTS_TOTAL) {
      return json({ error: "Alert capacity reached. Try again later." }, 429, {}, allowedOrigin);
    }

    const mine = searches.filter((s) => s.ownerKey === ownerKey);
    if (mine.length >= MAX_ALERTS_PER_OWNER) {
      return json({ error: "Too many saved alerts. Delete one before adding another." }, 429, {}, allowedOrigin);
    }

    const duplicate = mine.find(
      (s) =>
        normalizeText(s.VehicleMake) === validated.VehicleMake &&
        normalizeText(s.VehicleModel || "") === normalizeText(validated.VehicleModel || "") &&
        Number(s.VehicleYear) === validated.VehicleYear &&
        normalizeText(s.pushEndpoint || "") === normalizeText(validated.pushEndpoint || "")
    );
    if (duplicate) {
      return json({ error: "You already saved this search." }, 409, {}, allowedOrigin);
    }

    const id = crypto.randomUUID();
    const base = {
      id,
      ownerKey,
      createdAt: new Date().toISOString(),
      VehicleMake: validated.VehicleMake,
      VehicleModel: validated.VehicleModel || "",
      VehicleYear: validated.VehicleYear,
      pushEndpoint: validated.pushEndpoint || null,
      pushAuth: validated.pushAuth || null,
      pushP256dh: validated.pushP256dh || null,
    };

    try {
      base.lastSnapshot = await runSavedSearch(base);
    } catch (err) {
      base.lastSnapshot = [];
      base.lastNotificationStatus = `prefetch failed: ${String(err?.message || err)}`;
    }

    searches.push(base);
    await kv.put(SAVED_SEARCHES_KV_KEY, JSON.stringify(searches));

    return json({ ok: true, alert: redactSearchForClient(base) }, 201, {}, allowedOrigin);
  }

  if (request.method === "DELETE") {
    const id = (idFromPath || url.searchParams.get("id") || "").trim();
    if (!id) return json({ error: "id is required" }, 400, {}, allowedOrigin);

    const saved = await kv.get(SAVED_SEARCHES_KV_KEY, { type: "json" });
    const searches = Array.isArray(saved) ? saved : [];
    const before = searches.length;
    const remaining = searches.filter((s) => !(s.id === id && s.ownerKey === ownerKey));
    if (remaining.length === before) return json({ error: "Not found" }, 404, {}, allowedOrigin);

    await kv.put(SAVED_SEARCHES_KV_KEY, JSON.stringify(remaining));
    return json({ ok: true }, 200, {}, allowedOrigin);
  }

  return json({ error: "Method not allowed" }, 405, {}, allowedOrigin);
}

function redactSearchForClient(search) {
  const { id, VehicleMake, VehicleModel, VehicleYear, createdAt, lastNotifiedAt, lastNotificationStatus, pushEndpoint } = search || {};
  return {
    id,
    VehicleMake,
    VehicleModel,
    VehicleYear: VehicleYear ?? null,
    hasPush: !!pushEndpoint,
    createdAt,
    lastNotifiedAt: lastNotifiedAt || null,
    lastNotificationStatus: lastNotificationStatus || null,
  };
}

async function validateAlertPayload(payload) {
  const VehicleMake = normalizeText(payload.VehicleMake || payload.make || "");
  const VehicleModel = normalizeText(payload.VehicleModel || payload.model || "");
  const VehicleYear = Number((payload.VehicleYear || payload.year || "").toString().trim());
  const pushEndpoint = normalizeText(payload.pushEndpoint || "");
  const pushAuth = normalizeText(payload.pushAuth || "");
  const pushP256dh = normalizeText(payload.pushP256dh || "");

  if (!VehicleMake) throw new Error("VehicleMake is required");
  if (VehicleMake.length > 48) throw new Error("VehicleMake too long");
  if (VehicleModel.length > 64) throw new Error("VehicleModel too long");
  if (!Number.isFinite(VehicleYear) || VehicleYear < 1900 || VehicleYear > 2100) {
    throw new Error("VehicleYear must be a valid year");
  }

  if (!pushEndpoint || !pushAuth || !pushP256dh) {
    throw new Error("Push subscription (endpoint, auth, p256dh) is required");
  }

  return { VehicleMake, VehicleModel, VehicleYear, pushEndpoint, pushAuth, pushP256dh };
}

async function hashOwner(request, env) {
  const ip = (request.headers.get("cf-connecting-ip") || "").trim();
  const ua = (request.headers.get("user-agent") || "").trim();
  const salt = (env?.ALERT_SIGNING_SECRET || "default-salt").trim();
  return await hashString(`${salt}:${ip}:${ua}`);
}

async function hashString(input) {
  const data = new TextEncoder().encode(input || "");
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeText(v) {
  return (v || "").toString().trim();
}

async function deliverNotifications(search, newVehicles, env) {
  if (search?.pushEndpoint && env?.ALERT_PUSH_ENDPOINT && env?.ALERT_PUSH_API_KEY) {
    const deliveries = [
      sendPushNotification({
        endpoint: search.pushEndpoint,
        auth: search.pushAuth,
        p256dh: search.pushP256dh,
        apiKey: env.ALERT_PUSH_API_KEY,
        gateway: env.ALERT_PUSH_ENDPOINT,
        search,
        newVehicles,
      }),
    ];

    const results = await Promise.allSettled(deliveries);
    return results
      .map((r) => (r.status === "fulfilled" ? r.value : `error: ${String(r.reason?.message || r.reason)}`))
      .join("; ");
  }

  return "no push subscription";
}

async function sendPushNotification({ endpoint, auth, p256dh, apiKey, gateway, search, newVehicles }) {
  const payload = {
    endpoint,
    keys: { auth, p256dh },
    search: { make: search.VehicleMake, model: search.VehicleModel || null, year: search.VehicleYear },
    count: newVehicles.length,
    sample: newVehicles.slice(0, 5),
  };

  const resp = await fetch(gateway, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`push failed (${resp.status}): ${txt}`);
  }

  return "push sent";
}

function pickAllowedOrigin(request, env) {
  const configured = (env?.ALLOWED_ORIGIN || env?.ALLOWED_ORIGINS || "*").trim();
  if (configured === "*") return "*";
  const reqOrigin = (request?.headers?.get("origin") || "").trim();
  const allowed = configured
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(reqOrigin)) return reqOrigin;
  return allowed[0] || "*";
}
