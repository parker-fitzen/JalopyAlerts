// Cloudflare Worker: CORS proxy + optional multi-yard aggregation + saved alerts
// NOTE: Be respectful: this multiplies upstream traffic. Add caching.

const JALOPY_UPSTREAM = "https://inventory.pickapartjalopyjungle.com";
const TRUSTY_UPSTREAM = "https://inventory.trustypickapart.com";
// Daily alert sweep at 09:00 UTC (2:00 a.m. MST) to avoid future schedule drift.
const DAILY_ALERT_CRON = "0 9 * * *";

const SAVED_SEARCHES_KV_KEY = "saved-searches";
const VAPID_KEYS_KV_KEY = "alert-vapid-keys";
const MAX_ALERTS_TOTAL = 500;
const MAX_ALERTS_PER_OWNER = 25;
const ALERT_ROUTE_PREFIX = "/alerts";

const YARDS = [
  { id: "1020", name: "BOISE", upstream: JALOPY_UPSTREAM, kind: "jalopy" },
  { id: "1021", name: "CALDWELL", upstream: JALOPY_UPSTREAM, kind: "jalopy" },
  { id: "1119", name: "GARDEN CITY", upstream: JALOPY_UPSTREAM, kind: "jalopy" },
  { id: "1022", name: "NAMPA", upstream: JALOPY_UPSTREAM, kind: "jalopy" },
  { id: "1099", name: "TWIN FALLS", upstream: JALOPY_UPSTREAM, kind: "jalopy" },
  { id: "trusty", name: "TRUSTY'S", upstream: TRUSTY_UPSTREAM, kind: "trusty" },
];

// Only these are forwarded upstream as-is:
const PASSTHRU_PATHS = new Set(["/", "/Home/GetMakes", "/Home/GetModels"]);

// These are handled by the worker (not forwarded):
const API_PATHS = new Set(["/api/searchAll", "/api/makesAll", "/api/modelsAll"]);

let cachedVapidKeys = null;

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
      if (url.pathname === `${ALERT_ROUTE_PREFIX}/notification` && request.method === "POST") {
        return await handleNotificationPoll(request, env, allowedOrigin);
      }
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

    const target = new URL(JALOPY_UPSTREAM + url.pathname);
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
      upstream: y.upstream,
      kind: y.kind,
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
      yards: YARDS.map(({ id, name }) => ({ id, name })),
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
    if (y.kind === "trusty") {
      return await fetchTrustyMakes(y.upstream);
    }
    const makes = await postJsonUpstream(y.upstream, "/Home/GetMakes", { yardId: y.id });
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
    if (y.kind === "trusty") {
      const models = await postJsonUpstream(y.upstream, "/Home/GetModels", { makeName, showInventory: true });
      return (Array.isArray(models) ? models : []).map((m) => (m?.model || "").toString()).filter(Boolean);
    }
    const models = await postJsonUpstream(y.upstream, "/Home/GetModels", { yardId: y.id, makeName });
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

async function fetchAndParseInventory({ yardId, yardName, upstream, kind, VehicleMake, VehicleModel }) {
  // Cache key (POST-safe) using a synthetic GET request
  const cacheKey = new Request(
    `https://cache.local/inv?yardId=${encodeURIComponent(yardId)}&source=${encodeURIComponent(
      kind || ""
    )}&make=${encodeURIComponent(VehicleMake)}&model=${encodeURIComponent(VehicleModel || "")}`
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return await cached.json();
  }

  const form = new FormData();
  if (kind !== "trusty") form.set("YardId", yardId);
  form.set("VehicleMake", VehicleMake);
  if (VehicleModel) form.set("VehicleModel", VehicleModel);

  const upstreamRes = await fetch(upstream + "/", {
    method: "POST",
    body: form,
    headers: {
      // mimic a normal browser-ish accept header
      Accept: "text/html,application/xhtml+xml",
    },
  });

  const html = await upstreamRes.text();
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

async function fetchTrustyMakes(upstreamBase) {
  const cacheKey = new Request(`https://cache.local/trusty-makes?upstream=${encodeURIComponent(upstreamBase)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    return await cached.json();
  }

  const r = await fetch(upstreamBase + "/", {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await r.text();
  const makes = parseTrustyMakes(html);
  const resp = new Response(JSON.stringify(makes), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
  });
  await cache.put(cacheKey, resp.clone());
  return makes;
}

function parseTrustyMakes(html) {
  const selectMatch = html.match(/<select[^>]*id=["']car-make["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!selectMatch) return [];
  const optionsHtml = selectMatch[1];
  const makes = [];
  const re = /<option[^>]*value=["']?([^"'>]*)["']?[^>]*>/gi;
  for (const match of optionsHtml.matchAll(re)) {
    const value = (match[1] || "").trim();
    if (!value) continue;
    makes.push(value);
  }
  return makes;
}

async function postJsonUpstream(upstreamBase, path, obj) {
  // jQuery on the site posts x-www-form-urlencoded (default $.ajax behavior).
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) body.set(k, String(v));

  const r = await fetch(upstreamBase + path, {
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
      next.lastNotificationStatus = delivery.status;
      next.lastNotificationPayload = delivery.payload;
    }

    refreshed.push(next);
  }

  await kv.put(SAVED_SEARCHES_KV_KEY, JSON.stringify(refreshed));
}

async function runSavedSearch(search) {
  const VehicleMake = (search?.VehicleMake || search?.make || "").toString().trim();
  const VehicleModel = (search?.VehicleModel || search?.model || "").toString().trim();
  const { minYear, maxYear } = deriveYearRange(search);

  if (!VehicleMake) return [];

  const jobs = YARDS.map((y) => async () => {
    const rows = await fetchAndParseInventory({
      yardId: y.id,
      yardName: y.name,
      upstream: y.upstream,
      kind: y.kind,
      VehicleMake,
      VehicleModel,
    });
    return rows;
  });

  const all = await runPool(jobs, 2);
  const flattened = all.flat();
  return flattened.filter((r) => {
    if (minYear !== null && Number(r.year) < minYear) return false;
    if (maxYear !== null && Number(r.year) > maxYear) return false;
    return true;
  });
}

function deriveYearRange(source, { strict = false } = {}) {
  const minYear = parseOptionalYear(source?.VehicleMinYear ?? source?.minYear, { strict });
  const maxYear = parseOptionalYear(source?.VehicleMaxYear ?? source?.maxYear, { strict });
  const singleYear = parseOptionalYear(source?.VehicleYear ?? source?.year, { strict });

  let normalizedMin = minYear ?? singleYear;
  let normalizedMax = maxYear ?? singleYear;

  if (normalizedMin !== null && normalizedMax !== null && normalizedMin > normalizedMax) {
    if (strict) throw new Error("VehicleMinYear must be before VehicleMaxYear");
    const hi = Math.max(normalizedMin, normalizedMax);
    normalizedMin = Math.min(normalizedMin, normalizedMax);
    normalizedMax = hi;
  }

  return { minYear: normalizedMin, maxYear: normalizedMax };
}

function parseOptionalYear(value, { strict = false } = {}) {
  const text = (value ?? "").toString().trim();
  if (!text) return null;
  const n = Number(text);
  const valid = Number.isFinite(n) && n >= 1900 && n <= 2100;
  if (!valid) {
    if (strict) throw new Error("Vehicle year must be between 1900 and 2100.");
    return null;
  }
  return n;
}

function yearRangesEqual(a, b) {
  return (a?.minYear ?? null) === (b?.minYear ?? null) && (a?.maxYear ?? null) === (b?.maxYear ?? null);
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
  const url = new URL(request.url);
  const idFromPath = url.pathname.length > ALERT_ROUTE_PREFIX.length ? url.pathname.slice(ALERT_ROUTE_PREFIX.length + 1) : null;

  if (request.method === "GET") {
    if (url.pathname.endsWith("/public-key")) {
      const vapid = await getVapidKeys(env);
      const body = {
        publicKey: vapid.publicKey,
        persistedToKV: vapid.persistedToKV,
      };
      if (vapid.persistenceError) {
        body.persistenceError = vapid.persistenceError;
      }
      return json(body, 200, { "Cache-Control": "public, max-age=300" }, allowedOrigin);
    }

    const kv = getSearchStore(env);
    if (!kv) return json({ error: "KV namespace not configured" }, 500, {}, allowedOrigin);

    const ownerKey = await hashOwner(request, env);

    const saved = await kv.get(SAVED_SEARCHES_KV_KEY, { type: "json" });
    const searches = Array.isArray(saved) ? saved : [];
    const mine = searches.filter((s) => s.ownerKey === ownerKey);
    return json({ count: mine.length, alerts: mine.map(redactSearchForClient) }, 200, {}, allowedOrigin);
  }

  if (request.method === "POST") {
    const kv = getSearchStore(env);
    if (!kv) return json({ error: "KV namespace not configured" }, 500, {}, allowedOrigin);

    const ownerKey = await hashOwner(request, env);
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

    const desiredRange = deriveYearRange(validated);
    const duplicate = mine.find((s) => {
      const range = deriveYearRange(s);
      return (
        normalizeText(s.VehicleMake) === validated.VehicleMake &&
        normalizeText(s.VehicleModel || "") === normalizeText(validated.VehicleModel || "") &&
        yearRangesEqual(range, desiredRange) &&
        normalizeText(s.pushEndpoint || "") === normalizeText(validated.pushEndpoint || "")
      );
    });
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
      VehicleMinYear: validated.VehicleMinYear ?? null,
      VehicleMaxYear: validated.VehicleMaxYear ?? null,
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
    const kv = getSearchStore(env);
    if (!kv) return json({ error: "KV namespace not configured" }, 500, {}, allowedOrigin);

    const ownerKey = await hashOwner(request, env);
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

async function handleNotificationPoll(request, env, allowedOrigin = "*") {
  const kv = getSearchStore(env);
  if (!kv) return json({ error: "KV namespace not configured" }, 500, {}, allowedOrigin);

  const body = await readBodyParams(request);
  const endpoint = normalizeText(body.endpoint || "");
  if (!endpoint) return json({ error: "endpoint is required" }, 400, {}, allowedOrigin);

  const saved = await kv.get(SAVED_SEARCHES_KV_KEY, { type: "json" });
  const searches = Array.isArray(saved) ? saved : [];
  const match = searches.find((s) => normalizeText(s.pushEndpoint || "") === endpoint);
  if (!match) return json({ notification: null }, 200, {}, allowedOrigin);

  return json(
    {
      notification: match.lastNotificationPayload || null,
      lastNotifiedAt: match.lastNotifiedAt || null,
      lastNotificationStatus: match.lastNotificationStatus || null,
    },
    200,
    {},
    allowedOrigin
  );
}

function redactSearchForClient(search) {
  const { id, VehicleMake, VehicleModel, VehicleYear, createdAt, lastNotifiedAt, lastNotificationStatus, pushEndpoint } = search || {};
  return {
    id,
    VehicleMake,
    VehicleModel,
    VehicleYear: VehicleYear ?? null,
    VehicleMinYear: search?.VehicleMinYear ?? null,
    VehicleMaxYear: search?.VehicleMaxYear ?? null,
    hasPush: !!pushEndpoint,
    createdAt,
    lastNotifiedAt: lastNotifiedAt || null,
    lastNotificationStatus: lastNotificationStatus || null,
  };
}

async function validateAlertPayload(payload) {
  const VehicleMake = normalizeText(payload.VehicleMake || payload.make || "");
  const VehicleModel = normalizeText(payload.VehicleModel || payload.model || "");
  const { minYear, maxYear } = deriveYearRange(payload, { strict: true });
  const subscription = normalizeSubscription(payload.subscription || payload.pushSubscription || null);
  const pushEndpoint = subscription?.endpoint || normalizeText(payload.pushEndpoint || "");
  const pushAuth = subscription?.auth || normalizeText(payload.pushAuth || "");
  const pushP256dh = subscription?.p256dh || normalizeText(payload.pushP256dh || "");

  if (!VehicleMake) throw new Error("VehicleMake is required");
  if (VehicleMake.length > 48) throw new Error("VehicleMake too long");
  if (VehicleModel.length > 64) throw new Error("VehicleModel too long");

  if (!pushEndpoint || !pushAuth || !pushP256dh) {
    throw new Error("Push subscription (endpoint, auth, p256dh) is required");
  }

  return {
    VehicleMake,
    VehicleModel,
    VehicleMinYear: minYear,
    VehicleMaxYear: maxYear,
    VehicleYear: minYear !== null && minYear === maxYear ? minYear : null,
    pushEndpoint,
    pushAuth,
    pushP256dh,
  };
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

function normalizeSubscription(sub) {
  if (!sub || typeof sub !== "object") return null;
  const endpoint = normalizeText(sub.endpoint || "");
  const auth = normalizeText(sub.keys?.auth || sub.auth || "");
  const p256dh = normalizeText(sub.keys?.p256dh || sub.p256dh || "");
  if (!endpoint || !auth || !p256dh) return null;
  return { endpoint, auth, p256dh };
}

async function deliverNotifications(search, newVehicles, env) {
  const payload = buildNotificationPayload(search, newVehicles);
  const vapid = await getVapidKeys(env);

  if (!vapid?.publicKey || !vapid?.privateKey) return { status: "push unavailable (missing VAPID keys)", payload };

  if (!search?.pushEndpoint) {
    return { status: "no push subscription", payload };
  }

  try {
    await sendWebPush({
      endpoint: search.pushEndpoint,
      vapid,
    });
    return { status: "push sent", payload };
  } catch (err) {
    return { status: `push failed: ${String(err?.message || err)}`, payload };
  }
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

function buildNotificationPayload(search, newVehicles) {
  const detail = `${describeYearRangeText(search)} ${search.VehicleMake}${search.VehicleModel ? ` ${search.VehicleModel}` : ""}`;
  const yardNames = Array.from(new Set(newVehicles.map((r) => r.yardName))).join(", ");
  const body = `${newVehicles.length} new arrival(s) at ${yardNames || "unknown yard"}.`;
  return {
    title: `Jalopy Alerts: ${detail}`,
    body,
    data: {
      alertId: search.id,
      count: newVehicles.length,
      yards: yardNames,
    },
  };
}

function describeYearRangeText(search) {
  const { minYear, maxYear } = deriveYearRange(search);
  if (minYear === null && maxYear === null) return "All years";
  if (minYear !== null && maxYear !== null) {
    if (minYear === maxYear) return `${minYear}`;
    return `${minYear}–${maxYear}`;
  }
  if (minYear !== null) return `${minYear}+`;
  return `≤${maxYear}`;
}

async function getVapidKeys(env) {
  const subject = (env?.ALERT_VAPID_SUBJECT || env?.VAPID_SUBJECT || "mailto:alerts@example.com").trim();
  const publicKey = (env?.ALERT_VAPID_PUBLIC_KEY || env?.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (env?.ALERT_VAPID_PRIVATE_KEY || env?.VAPID_PRIVATE_KEY || "").trim();
  const kv = getVapidKeyStore(env);

  if (publicKey && privateKey) {
    cachedVapidKeys = { publicKey, privateKey, subject, persistedToKV: false, persistenceError: null };
    return cachedVapidKeys;
  }

  if (cachedVapidKeys) {
    if (kv && !cachedVapidKeys.persistedToKV) {
      try {
        await kv.put(
          VAPID_KEYS_KV_KEY,
          JSON.stringify({ publicKey: cachedVapidKeys.publicKey, privateKey: cachedVapidKeys.privateKey, subject })
        );
        cachedVapidKeys.persistedToKV = true;
        cachedVapidKeys.persistenceError = null;
      } catch (err) {
        cachedVapidKeys.persistenceError = `KV write failed: ${String(err?.message || err)}`;
        console.error("vapid kv write failed", { error: err });
      }
    }
    return cachedVapidKeys;
  }

  let persistenceError = kv ? null : "KV namespace not configured for VAPID keys";

  if (kv) {
    try {
      const stored = await kv.get(VAPID_KEYS_KV_KEY, { type: "json" });
      if (stored?.publicKey && stored?.privateKey) {
        cachedVapidKeys = {
          publicKey: stored.publicKey,
          privateKey: stored.privateKey,
          subject: stored.subject || subject,
          persistedToKV: true,
          persistenceError: null,
        };
        return cachedVapidKeys;
      }
    } catch (err) {
      persistenceError = `KV read failed: ${String(err?.message || err)}`;
      console.error("vapid kv read failed", { error: err });
    }
  }

  const generated = await generateVapidKeyPair(subject);
  cachedVapidKeys = { ...generated, persistedToKV: false, persistenceError };

  if (kv) {
    try {
      await kv.put(VAPID_KEYS_KV_KEY, JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey, subject }));
      cachedVapidKeys.persistedToKV = true;
      cachedVapidKeys.persistenceError = null;
    } catch (err) {
      cachedVapidKeys.persistenceError = `KV write failed: ${String(err?.message || err)}`;
      console.error("vapid kv write failed", { error: err });
    }
  }

  return cachedVapidKeys;
}

function getVapidKeyStore(env) {
  return env?.ALERT_VAPID_KEYS || env?.VAPID_KEYS || getSearchStore(env);
}

async function generateVapidKeyPair(subject) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  return { publicKey: base64UrlEncode(publicKey, true), privateKey: base64UrlEncode(privateKey, true), subject };
}

async function sendWebPush({ endpoint, vapid }) {
  const aud = new URL(endpoint).origin;
  const token = await createVapidJwt({ aud, vapid });
  const headers = {
    TTL: "43200",
    Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
  };

  // Send a minimal payload-free push; the service worker will fetch details.
  const resp = await fetch(endpoint, { method: "POST", headers });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`push failed (${resp.status}): ${txt}`);
  }

  return "push sent";
}

async function createVapidJwt({ aud, vapid }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 60 * 60; // 12h
  const header = { alg: "ES256", typ: "JWT" };
  const payload = { aud, exp, sub: vapid.subject };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const keyData = base64UrlToUint8Array(vapid.privateKey);

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(signature, true)}`;
}

function base64UrlEncode(input, isBuffer = false) {
  const raw = isBuffer ? new Uint8Array(input) : new TextEncoder().encode(input);
  let str = btoa(String.fromCharCode(...raw));
  str = str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return str;
}

function base64UrlToUint8Array(base64String) {
  const padded = base64String.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
