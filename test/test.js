const els = {
  make: document.getElementById("make"),
  model: document.getElementById("model"),
  minYear: document.getElementById("minYear"),
  maxYear: document.getElementById("maxYear"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  alertsList: document.getElementById("alertsList"),
  notificationPreview: document.getElementById("notificationPreview"),
  runMockSearch: document.getElementById("runMockSearch"),
};

const MOCK_ALERTS = [
  {
    id: "alert-toyota-camry",
    VehicleMake: "TOYOTA",
    VehicleModel: "CAMRY",
    VehicleMinYear: 2010,
    VehicleMaxYear: 2015,
    createdAt: "2026-03-18T09:00:00.000Z",
    hasPush: true,
    newKeys: ["1020:2014:TOYOTA:CAMRY:ROW-42"],
    notification: {
      title: "Jalopy Alerts: 2010–2015 TOYOTA CAMRY",
      body: "1 new arrival @ JJ BOISE — 03-25-2026\n- Vehicle: 2014 TOYOTA CAMRY • Location: JJ BOISE • Row: ROW-42",
      arrivalDate: "03-25-2026",
    },
  },
  {
    id: "alert-honda-any",
    VehicleMake: "HONDA",
    VehicleModel: "",
    VehicleMinYear: 2005,
    VehicleMaxYear: null,
    createdAt: "2026-03-21T14:30:00.000Z",
    hasPush: true,
    newKeys: ["1022:2008:HONDA:ACCORD:ROW-9"],
    notification: {
      title: "Jalopy Alerts: 2005+ HONDA",
      body: "1 new arrival @ JJ NAMPA — 03-24-2026\n- Vehicle: 2008 HONDA ACCORD • Location: JJ NAMPA • Row: ROW-9",
      arrivalDate: "03-24-2026",
    },
  },
];

const MOCK_ROWS = [
  { yardId: "1020", yardName: "BOISE", year: 2014, make: "TOYOTA", model: "CAMRY", row: "ROW-42" },
  { yardId: "1021", yardName: "CALDWELL", year: 2012, make: "TOYOTA", model: "CAMRY", row: "ROW-5" },
  { yardId: "1022", yardName: "NAMPA", year: 2008, make: "HONDA", model: "ACCORD", row: "ROW-9" },
  { yardId: "1119", yardName: "GARDEN CITY", year: 2013, make: "TOYOTA", model: "COROLLA", row: "ROW-1" },
];

let activeAlert = MOCK_ALERTS[0];
let highlightedKeys = new Set(activeAlert.newKeys);

function setStatus(msg, kind = "") {
  els.status.className = `status${kind ? ` ${kind}` : ""}`;
  els.status.textContent = msg;
}

function inventoryKey(row) {
  return [row.yardId, row.year, row.make, row.model, row.row].join(":");
}

function prettyRange(alert) {
  const min = alert.VehicleMinYear;
  const max = alert.VehicleMaxYear;
  if (!min && !max) return "All years";
  if (min && max) return min === max ? `${min}` : `${min}–${max}`;
  if (min) return `${min}+`;
  return `≤${max}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderNotificationPreview() {
  const n = activeAlert.notification;
  els.notificationPreview.innerHTML = `
    <h3 style="margin-top:0;">Notification Preview (Mock)</h3>
    <div class="muted-border ok" style="margin-top:10px;">
      <div style="font-weight:700;">${escapeHtml(n.title)}</div>
      <div style="margin-top:6px; white-space: pre-line;">${escapeHtml(n.body)}</div>
      <div class="muted" style="margin-top:6px;">Arrival date: ${escapeHtml(n.arrivalDate)}</div>
    </div>
  `;
}

function renderResults() {
  const make = (els.make.value || "").trim();
  const model = (els.model.value || "").trim();
  const minYear = Number(els.minYear.value || 0) || null;
  const maxYear = Number(els.maxYear.value || 0) || null;

  const filtered = MOCK_ROWS.filter((r) => {
    if (make && r.make !== make) return false;
    if (model && r.model !== model) return false;
    if (minYear && r.year < minYear) return false;
    if (maxYear && r.year > maxYear) return false;
    return true;
  });

  els.results.innerHTML = "";
  if (!filtered.length) {
    els.results.innerHTML = '<tr><td class="muted" colspan="5">No mock matches.</td></tr>';
    setStatus("0 mock result(s).", "");
    return;
  }

  for (const row of filtered) {
    const isNew = highlightedKeys.has(inventoryKey(row));
    const badge = isNew ? ' <span class="new-arrival-tag">NEW</span>' : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.yardName)}</td>
      <td>${escapeHtml(row.year)}</td>
      <td>${escapeHtml(row.make)}</td>
      <td>${escapeHtml(row.model)}</td>
      <td>${escapeHtml(row.row)}${badge}</td>
    `;
    els.results.appendChild(tr);
  }

  setStatus(`${filtered.length} mock result(s) shown.`, "ok");
}

function renderAlerts() {
  els.alertsList.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const alert of MOCK_ALERTS) {
    const row = document.createElement("div");
    row.className = "alert-row";
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    const left = document.createElement("div");
    left.innerHTML = `
      <div class="alert-primary">${escapeHtml(alert.VehicleMake)}${alert.VehicleModel ? ` — ${escapeHtml(alert.VehicleModel)}` : " (any model)"} (${escapeHtml(prettyRange(alert))})</div>
      <div class="alert-meta">Created ${new Date(alert.createdAt).toLocaleString()}</div>
      <div class="alert-meta">Push subscription: ${alert.hasPush ? "set" : "missing"}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "alert-actions";
    actions.innerHTML = '<span class="chip">Mock alert</span>';

    const activate = () => {
      activeAlert = alert;
      highlightedKeys = new Set(alert.newKeys);
      els.make.value = alert.VehicleMake || "";
      syncModels();
      els.model.value = alert.VehicleModel || "";
      els.minYear.value = alert.VehicleMinYear || "";
      els.maxYear.value = alert.VehicleMaxYear || "";
      renderNotificationPreview();
      renderResults();
    };

    row.addEventListener("click", activate);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activate();
      }
    });

    row.appendChild(left);
    row.appendChild(actions);
    frag.appendChild(row);
  }

  els.alertsList.appendChild(frag);
}

function populateMakes() {
  const makes = Array.from(new Set(MOCK_ROWS.map((r) => r.make))).sort();
  els.make.innerHTML = '<option value="">Any make</option>';
  for (const make of makes) {
    const opt = document.createElement("option");
    opt.value = make;
    opt.textContent = make;
    els.make.appendChild(opt);
  }
}

function syncModels() {
  const make = (els.make.value || "").trim();
  const models = Array.from(new Set(MOCK_ROWS.filter((r) => !make || r.make === make).map((r) => r.model))).sort();
  const current = els.model.value;
  els.model.innerHTML = '<option value="">Any model</option>';
  for (const model of models) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    els.model.appendChild(opt);
  }
  if (models.includes(current)) els.model.value = current;
}

function init() {
  populateMakes();
  syncModels();
  renderAlerts();

  els.make.value = activeAlert.VehicleMake;
  syncModels();
  els.model.value = activeAlert.VehicleModel;
  els.minYear.value = activeAlert.VehicleMinYear;
  els.maxYear.value = activeAlert.VehicleMaxYear;

  renderNotificationPreview();
  renderResults();

  els.make.addEventListener("change", () => {
    syncModels();
    renderResults();
  });
  els.model.addEventListener("change", renderResults);
  els.minYear.addEventListener("input", renderResults);
  els.maxYear.addEventListener("input", renderResults);
  els.runMockSearch.addEventListener("click", renderResults);
}

init();
