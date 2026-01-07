// Your deployed proxy Worker
const BASE = "https://jalprox.parkfitz.workers.dev";
const ALERTS_BASE = `${BASE}/alerts`;

// Yard list (name + ID) from the upstream page
const YARDS = [
  { id: "1020", name: "BOISE" },
  { id: "1021", name: "CALDWELL" },
  { id: "1119", name: "GARDEN CITY" },
  { id: "1022", name: "NAMPA" },
  { id: "1099", name: "TWIN FALLS" },
  { id: "TRUSTY", name: "TRUSTY'S" },
];

const els = {
  make: document.getElementById("make"),
  model: document.getElementById("model"),
  minYear: document.getElementById("minYear"),
  maxYear: document.getElementById("maxYear"),
  searchBtn: document.getElementById("searchBtn"),
  resetBtn: document.getElementById("resetBtn"),
  status: document.getElementById("status"),
  alertMinYear: document.getElementById("alertMinYear"),
  alertMaxYear: document.getElementById("alertMaxYear"),
  enablePushBtn: document.getElementById("enablePushBtn"),
  pushStatus: document.getElementById("pushStatus"),
  alertStatus: document.getElementById("alertStatus"),
  alertNotes: document.getElementById("alertNotes"),
  saveAlertBtn: document.getElementById("saveAlertBtn"),
  refreshAlertsBtn: document.getElementById("refreshAlertsBtn"),
  alertsList: document.getElementById("alertsList"),
  results: document.getElementById("results"),
  yardCounts: document.getElementById("yardCounts"),
  quickFilter: document.getElementById("quickFilter"),
  sort: document.getElementById("sort"),
};

// In-memory caches
let makesCache = null; // string[]
const modelsCache = new Map(); // make -> string[]

// Last full result set (unfiltered by quick filter)
let lastRows = [];
let alertsCache = [];
let pushSubscription = null;
let vapidPublicKey = null;
let swReadyPromise = null;

// Simple polite concurrency limiter
async function runPool(tasks, limit = 2, delayMs = 120) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function setStatus(msg, kind = "") {
  els.status.className = "status" + (kind ? " " + kind : "");
  els.status.textContent = msg;
}

function setAlertStatus(msg, kind = "") {
  els.alertStatus.className = "status" + (kind ? " " + kind : "");
  els.alertStatus.textContent = msg;
}

function setPushStatus(msg, kind = "") {
  if (!els.pushStatus) return;
  els.pushStatus.className = "muted-border" + (kind ? " " + kind : "");
  els.pushStatus.textContent = msg;
}

function describeCurrentSelection() {
  const make = (els.make.value || "").trim();
  const model = (els.model.value || "").trim();
  if (!make) return null;
  return { make, model };
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function ensureServiceWorkerReady() {
  if (!("serviceWorker" in navigator)) throw new Error("Service workers not supported in this browser.");
  if (!swReadyPromise) {
    swReadyPromise = navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
  }
  return swReadyPromise;
}

async function fetchVapidKey() {
  if (vapidPublicKey) return vapidPublicKey;
  const data = await alertsApi("/public-key", { method: "GET" });
  vapidPublicKey = data.publicKey;
  return vapidPublicKey;
}

async function ensurePushSubscription() {
  if (!("Notification" in window) || !("PushManager" in window)) {
    throw new Error("Push notifications are not supported in this browser.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission not granted.");

  const reg = await ensureServiceWorkerReady();
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    pushSubscription = existing;
    return existing;
  }

  const publicKey = await fetchVapidKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  pushSubscription = sub;
  return sub;
}

async function updatePushStatusText() {
  try {
    const reg = await ensureServiceWorkerReady();
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      pushSubscription = sub;
      setPushStatus("Push notifications are active for this browser.", "ok");
    } else {
      setPushStatus("Push notifications are not enabled yet. Click below and accept the prompt to turn them on.");
    }
  } catch (e) {
    setPushStatus(e.message || "Push notifications are unavailable.", "err");
  }
}

function subscriptionPayload(sub) {
  const json = sub?.toJSON?.();
  if (!json) return null;
  return {
    endpoint: json.endpoint,
    keys: json.keys || {},
  };
}

function updateAlertNotes() {
  const selection = describeCurrentSelection();
  if (!selection) {
    els.alertNotes.textContent = "Pick a make/model above, then save the alert.";
    return;
  }
  const detail = selection.model ? `${selection.make} — ${selection.model}` : `${selection.make} (any model)`;
  const minY = normalizeYear(els.alertMinYear.value);
  const maxY = normalizeYear(els.alertMaxYear.value);
  const yearText = describeYearRange(minY, maxY);
  els.alertNotes.textContent = `Alert will track: ${detail} — ${yearText}.`;
}

function clearResults(message = "") {
  els.results.innerHTML = "";
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 5;
  td.className = "muted";
  td.textContent = message || "No results.";
  tr.appendChild(td);
  els.results.appendChild(tr);
}

function formBody(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s === "") continue;
    p.set(k, s);
  }
  return p;
}

async function postJson(path, bodyObj) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: formBody(bodyObj),
  });
  if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
  return await r.json();
}

async function alertsApi(path, { method = "GET", body } = {}) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(ALERTS_BASE + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error || `${method} ${path} failed (${r.status})`;
    throw new Error(msg);
  }
  return data;
}

async function postHtml(path, bodyObj) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "Accept": "text/html" },
    body: formBody(bodyObj),
  });
  if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
  return await r.text();
}

function parseInventoryHtml(html) {
  // DOM parsing is more robust than regex.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table.table");
  if (!table) return [];
  const trs = Array.from(table.querySelectorAll("tr"));
  const rows = [];
  for (const tr of trs) {
    const tds = tr.querySelectorAll("td");
    if (!tds || tds.length < 4) continue;
    const year = Number((tds[0].textContent || "").trim());
    const make = (tds[1].textContent || "").trim();
    const model = (tds[2].textContent || "").trim();
    const row = (tds[3].textContent || "").trim();
    if (!year || !make || !model) continue;
    rows.push({ year, make, model, row });
  }
  return rows;
}

function normalizeYear(v) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function describeYearRange(minY, maxY) {
  const hasMin = minY !== null;
  const hasMax = maxY !== null;
  if (!hasMin && !hasMax) return "all years";
  if (hasMin && hasMax) {
    if (minY === maxY) return `year ${minY}`;
    return `${minY}–${maxY}`;
  }
  if (hasMin) return `from ${minY}`;
  return `through ${maxY}`;
}

function extractAlertYearRange(alert) {
  const minY = normalizeYear(alert?.VehicleMinYear ?? alert?.minYear);
  const maxY = normalizeYear(alert?.VehicleMaxYear ?? alert?.maxYear);
  const single = normalizeYear(alert?.VehicleYear ?? alert?.year);
  return {
    minYear: minY ?? single,
    maxYear: maxY ?? single,
  };
}

function applyFiltersAndRender() {
  const q = (els.quickFilter.value || "").trim().toUpperCase();
  const minY = normalizeYear(els.minYear.value);
  const maxY = normalizeYear(els.maxYear.value);

  let rows = lastRows.slice();

  // Year filtering
  if (minY !== null) rows = rows.filter(r => r.year >= minY);
  if (maxY !== null) rows = rows.filter(r => r.year <= maxY);

  // Quick filter (yard/make/model/row)
  if (q) {
    rows = rows.filter(r => {
      const hay = `${r.yardName} ${r.make} ${r.model} ${r.row} ${r.year}`.toUpperCase();
      return hay.includes(q);
    });
  }

  // Sort
  const sort = els.sort.value;
  rows.sort((a, b) => {
    if (sort === "year_desc") return b.year - a.year;
    if (sort === "year_asc") return a.year - b.year;
    if (sort === "yard_asc") return a.yardName.localeCompare(b.yardName) || (b.year - a.year);
    if (sort === "yard_desc") return b.yardName.localeCompare(a.yardName) || (b.year - a.year);
    return 0;
  });

  renderRows(rows);
  renderYardCounts(rows);

  if (!rows.length) setStatus("0 results after filters.", "");
  else setStatus(`${rows.length} result(s) shown.`, "ok");
}

function renderRows(rows) {
  els.results.innerHTML = "";
  if (!rows.length) {
    clearResults("No matches.");
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.yardName)}</td>
      <td>${escapeHtml(String(r.year))}</td>
      <td>${escapeHtml(r.make)}</td>
      <td>${escapeHtml(r.model)}</td>
      <td>${escapeHtml(r.row)}</td>
    `;
    frag.appendChild(tr);
  }
  els.results.appendChild(frag);
}

function renderYardCounts(rows) {
  const counts = new Map();
  for (const y of YARDS) counts.set(y.name, 0);
  for (const r of rows) counts.set(r.yardName, (counts.get(r.yardName) || 0) + 1);

  els.yardCounts.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const y of YARDS) {
    const div = document.createElement("div");
    div.className = "pill";
    div.textContent = `${y.name}: ${counts.get(y.name) || 0}`;
    frag.appendChild(div);
  }
  els.yardCounts.appendChild(frag);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadMakesAllYards() {
  setStatus("Loading makes across yards…");
  els.make.disabled = true;
  els.model.disabled = true;
  els.searchBtn.disabled = true;

  let data;
  try {
    data = await postJson("/api/makesAll", {});
  } catch (e) {
    setStatus(e.message || "Failed to load makes.", "err");
    return;
  }

  const makes = Array.isArray(data?.makes) ? data.makes : [];
  makesCache = makes.slice().sort((a, b) => a.localeCompare(b));

  // Populate Make dropdown
  els.make.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Select make";
  els.make.appendChild(opt0);
  for (const m of makesCache) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    els.make.appendChild(opt);
  }

  els.make.disabled = false;
  els.model.innerHTML = '<option value="">Select a make first</option>';
  els.model.disabled = true;
  els.searchBtn.disabled = true;

  setStatus(`Makes loaded from ${YARDS.length} yard(s).`, "ok");

  clearResults("Select a make/model, then search.");
  els.yardCounts.innerHTML = "";
}

async function loadModelsAllYards(make) {
  if (!make) {
    els.model.innerHTML = '<option value="">Select a make first</option>';
    els.model.disabled = true;
    els.searchBtn.disabled = true;
    return;
  }

  if (modelsCache.has(make)) {
    populateModels(modelsCache.get(make));
    return;
  }

  setStatus(`Loading models for ${make}…`);
  els.model.disabled = true;
  els.searchBtn.disabled = true;
  els.model.innerHTML = '<option value="">Loading…</option>';

  let data;
  try {
    data = await postJson("/api/modelsAll", { makeName: make });
  } catch (e) {
    setStatus(e.message || "Failed to load models.", "err");
    return;
  }

  const models = Array.isArray(data?.models) ? data.models.slice().sort((a, b) => a.localeCompare(b)) : [];
  modelsCache.set(make, models);
  populateModels(models);

  setStatus("Models loaded.", "ok");
}

function populateModels(models) {
  els.model.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Any model";
  els.model.appendChild(opt0);
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    els.model.appendChild(opt);
  }
  els.model.disabled = false;
  els.searchBtn.disabled = false;
}

async function searchAllYards() {
  const make = (els.make.value || "").trim();
  const model = (els.model.value || "").trim();

  if (!make) {
    setStatus("Pick a make first.", "err");
    return;
  }

  const minY = normalizeYear(els.minYear.value);
  const maxY = normalizeYear(els.maxYear.value);
  if (minY !== null && maxY !== null && minY > maxY) {
    setStatus("Year range is backwards (min > max).", "err");
    return;
  }

  setStatus("Searching all yards…");
  els.searchBtn.disabled = true;
  clearResults("Searching…");
  els.yardCounts.innerHTML = "";

  let data;
  try {
    data = await postJson("/api/searchAll", { VehicleMake: make, VehicleModel: model || "" });
  } catch (e) {
    setStatus(e.message || "Search failed.", "err");
    clearResults("Search failed.");
    els.searchBtn.disabled = false;
    return;
  }

  const allRows = Array.isArray(data?.results) ? data.results : [];
  lastRows = allRows;
  els.searchBtn.disabled = false;

  if (!allRows.length) {
    setStatus("No results.", "");
    clearResults("No matches returned from any yard.");
    renderYardCounts([]);
    return;
  }

  setStatus(`Fetched ${allRows.length} raw rows.`, "ok");

  // Apply year range + quick filter + sort and render.
  applyFiltersAndRender();
}

function formatTimestamp(ts) {
  if (!ts) return "never";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function renderAlerts(alerts, errorMsg = "") {
  els.alertsList.innerHTML = "";
  if (errorMsg) {
    const div = document.createElement("div");
    div.className = "alert-row";
    div.innerHTML = `<div class="alert-meta">${escapeHtml(errorMsg)}</div>`;
    els.alertsList.appendChild(div);
    return;
  }

  if (!alerts || !alerts.length) {
    const div = document.createElement("div");
    div.className = "alert-row";
    div.innerHTML = `<div class="alert-meta">No saved alerts yet. Save one above.</div>`;
    els.alertsList.appendChild(div);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const a of alerts) {
    const row = document.createElement("div");
    row.className = "alert-row";

    const left = document.createElement("div");
    const headline = document.createElement("div");
    headline.className = "alert-primary";
    const { minYear, maxYear } = extractAlertYearRange(a);
    const yearText = describeYearRange(minYear, maxYear);
    headline.textContent = `${a.VehicleMake}${a.VehicleModel ? " — " + a.VehicleModel : " (any model)"} (${yearText})`;

    const meta = document.createElement("div");
    meta.className = "alert-meta";
    meta.textContent = `Push subscription: ${a.hasPush ? "set" : "missing"} • Created ${formatTimestamp(a.createdAt)}`;

    const statusLine = document.createElement("div");
    statusLine.className = "alert-meta";
    const status = a.lastNotificationStatus || "No notifications sent yet.";
    statusLine.textContent = `Last notified: ${formatTimestamp(a.lastNotifiedAt)} (${status})`;

    left.appendChild(headline);
    left.appendChild(meta);
    left.appendChild(statusLine);

    const actions = document.createElement("div");
    actions.className = "alert-actions";
    const statusChip = document.createElement("span");
    statusChip.className = "chip";
    statusChip.textContent = a.lastNotificationStatus ? "Active" : "New";
    actions.appendChild(statusChip);

    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteAlert(a.id));
    actions.appendChild(del);

    row.appendChild(left);
    row.appendChild(actions);
    frag.appendChild(row);
  }

  els.alertsList.appendChild(frag);
}

async function loadAlerts() {
  try {
    setAlertStatus("Loading saved alerts…");
    const data = await alertsApi("", { method: "GET" });
    alertsCache = data.alerts || [];
    renderAlerts(alertsCache);
    setAlertStatus(`Loaded ${alertsCache.length} alert(s).`, "ok");
  } catch (e) {
    alertsCache = [];
    renderAlerts([], e.message || String(e));
    setAlertStatus(e.message || "Failed to load alerts.", "err");
  }
}

async function saveAlert() {
  const selection = describeCurrentSelection();
  if (!selection) {
    setAlertStatus("Pick a make/model first.", "err");
    return;
  }

  const minYear = normalizeYear(els.alertMinYear.value);
  const maxYear = normalizeYear(els.alertMaxYear.value);
  if (minYear !== null && maxYear !== null && minYear > maxYear) {
    setAlertStatus("Year range is backwards (min > max).", "err");
    return;
  }

  setAlertStatus("Saving alert…");
  try {
    const sub = await ensurePushSubscription();
    const subscription = subscriptionPayload(sub);

    await alertsApi("", {
      method: "POST",
      body: {
        VehicleMake: selection.make,
        VehicleModel: selection.model,
        VehicleMinYear: minYear,
        VehicleMaxYear: maxYear,
        VehicleYear: minYear !== null && minYear === maxYear ? minYear : null,
        subscription,
      },
    });
    setAlertStatus("Alert saved.", "ok");
    await loadAlerts();
    await updatePushStatusText();
  } catch (e) {
    setAlertStatus(e.message || "Failed to save alert.", "err");
  }
}

async function deleteAlert(id) {
  if (!id) return;
  setAlertStatus("Deleting alert…");
  try {
    await alertsApi(`/${encodeURIComponent(id)}`, { method: "DELETE" });
    alertsCache = alertsCache.filter(a => a.id !== id);
    renderAlerts(alertsCache);
    setAlertStatus("Alert deleted.", "ok");
  } catch (e) {
    setAlertStatus(e.message || "Failed to delete alert.", "err");
  }
}

// Event wiring
els.make.addEventListener("change", async () => {
  const make = (els.make.value || "").trim();
  els.quickFilter.value = "";
  lastRows = [];
  clearResults("Loading models…");
  els.yardCounts.innerHTML = "";
  await loadModelsAllYards(make);
  clearResults("Select a model (or Any), then search.");
  updateAlertNotes();
});

els.model.addEventListener("change", () => {
  els.quickFilter.value = "";
  lastRows = [];
  clearResults("Ready to search.");
  els.yardCounts.innerHTML = "";
  updateAlertNotes();
});

els.alertMinYear.addEventListener("input", () => updateAlertNotes());
els.alertMaxYear.addEventListener("input", () => updateAlertNotes());

els.searchBtn.addEventListener("click", () => searchAllYards());

els.saveAlertBtn.addEventListener("click", () => saveAlert());
els.refreshAlertsBtn.addEventListener("click", () => loadAlerts());
els.enablePushBtn.addEventListener("click", async () => {
  setPushStatus("Requesting permission…");
  try {
    await ensurePushSubscription();
    setPushStatus("Push notifications are active for this browser.", "ok");
  } catch (e) {
    setPushStatus(e.message || "Push permission denied.", "err");
  }
});

els.resetBtn.addEventListener("click", async () => {
  els.minYear.value = "";
  els.maxYear.value = "";
  els.quickFilter.value = "";
  els.sort.value = "year_desc";
  modelsCache.clear();
  lastRows = [];
  els.make.value = "";
  els.model.innerHTML = '<option value="">Select a make first</option>';
  els.model.disabled = true;
  els.searchBtn.disabled = true;
  els.alertMinYear.value = "";
  els.alertMaxYear.value = "";
  clearResults("Reset. Select a make.");
  els.yardCounts.innerHTML = "";
  setStatus("Reset.");
  updateAlertNotes();
  setAlertStatus("");
  updatePushStatusText();
});

els.quickFilter.addEventListener("input", () => {
  if (!lastRows.length) return;
  applyFiltersAndRender();
});

els.sort.addEventListener("change", () => {
  if (!lastRows.length) return;
  applyFiltersAndRender();
});

// If user edits year range after search, re-filter instantly
els.minYear.addEventListener("input", () => { if (lastRows.length) applyFiltersAndRender(); });
els.maxYear.addEventListener("input", () => { if (lastRows.length) applyFiltersAndRender(); });

// Boot
(async function init() {
  try {
    await loadMakesAllYards();
    updateAlertNotes();
    await loadAlerts();
    await updatePushStatusText();
  } catch (e) {
    setStatus("Failed to load makes. Check Worker URL + CORS.", "err");
    els.make.disabled = true;
    els.model.disabled = true;
    els.searchBtn.disabled = true;
    clearResults("Error loading makes.");
    console.error(e);
    setAlertStatus("Alerts unavailable.", "err");
  }
})();
