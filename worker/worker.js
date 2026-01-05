// Cloudflare Worker: CORS proxy + optional multi-yard aggregation
// NOTE: Be respectful: this multiplies upstream traffic. Add caching.

const UPSTREAM = "https://inventory.pickapartjalopyjungle.com";

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
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ---- Worker-handled API endpoints ----
    if (API_PATHS.has(url.pathname)) {
      try {
        if (url.pathname === "/api/searchAll") {
          return await handleSearchAll(request);
        }
        if (url.pathname === "/api/makesAll") {
          return await handleMakesAll(request);
        }
        if (url.pathname === "/api/modelsAll") {
          return await handleModelsAll(request);
        }
        return json({ error: "Not found" }, 404);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 500);
      }
    }

    // ---- Passthrough proxy (locked-down) ----
    if (!PASSTHRU_PATHS.has(url.pathname)) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders() });
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
    for (const [k, v] of Object.entries(corsHeaders())) outHeaders.set(k, v);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  },
};

async function handleSearchAll(request) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const params = await readBodyParams(request);
  const VehicleMake = (params.VehicleMake || params.make || "").toString().trim();
  const VehicleModel = (params.VehicleModel || params.model || "").toString().trim();

  if (!VehicleMake) return json({ error: "VehicleMake is required" }, 400);

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
    }
  );
}

async function handleMakesAll(request) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const jobs = YARDS.map((y) => async () => {
    const makes = await postJsonUpstream("/Home/GetMakes", { yardId: y.id });
    // upstream returns [{ makeName: "TOYOTA" }, ...]
    return (Array.isArray(makes) ? makes : []).map((m) => (m?.makeName || "").toString()).filter(Boolean);
  });

  const lists = await runPool(jobs, 2);
  const set = new Set(lists.flat());
  const merged = Array.from(set).sort((a, b) => a.localeCompare(b));

  return json({ count: merged.length, makes: merged }, 200, { "Cache-Control": "public, max-age=3600" });
}

async function handleModelsAll(request) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const params = await readBodyParams(request);
  const makeName = (params.makeName || params.VehicleMake || params.make || "").toString().trim();
  if (!makeName) return json({ error: "makeName is required" }, 400);

  const jobs = YARDS.map((y) => async () => {
    const models = await postJsonUpstream("/Home/GetModels", { yardId: y.id, makeName });
    // upstream returns [{ model: "PRIUS" }, ...]
    return (Array.isArray(models) ? models : []).map((m) => (m?.model || "").toString()).filter(Boolean);
  });

  const lists = await runPool(jobs, 2);
  const set = new Set(lists.flat());
  const merged = Array.from(set).sort((a, b) => a.localeCompare(b));

  return json({ makeName, count: merged.length, models: merged }, 200, { "Cache-Control": "public, max-age=3600" });
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

function json(obj, status = 200, extraHeaders = {}) {
  const h = new Headers({ "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders });
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
