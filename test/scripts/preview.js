const DEMO_ALERTS = [
  {
    id: "demo-camry",
    VehicleMake: "TOYOTA",
    VehicleModel: "CAMRY",
    VehicleMinYear: 2010,
    VehicleMaxYear: 2015,
    createdAt: "2026-03-20T08:15:00.000Z",
    lastNotifiedAt: "2026-03-25T09:00:00.000Z",
    lastNotificationStatus: "push sent",
    notification: {
      title: "Jalopy Alerts: 2010–2015 TOYOTA CAMRY",
      body: "1 new arrival at BOISE. 2013 row 42 (JJ BOISE) — 2026-03-25",
      newVehicleKeys: ["1020:2013:TOYOTA:CAMRY:42"],
    },
    rows: [
      { yardId: "1020", yardName: "BOISE", year: 2013, make: "TOYOTA", model: "CAMRY", row: "42" },
      { yardId: "1022", yardName: "NAMPA", year: 2012, make: "TOYOTA", model: "CAMRY", row: "17" },
      { yardId: "1099", yardName: "TWIN FALLS", year: 2011, make: "TOYOTA", model: "CAMRY", row: "09" },
    ],
  },
  {
    id: "demo-civic",
    VehicleMake: "HONDA",
    VehicleModel: "CIVIC",
    VehicleMinYear: 2006,
    VehicleMaxYear: 2012,
    createdAt: "2026-03-18T03:10:00.000Z",
    lastNotifiedAt: "2026-03-24T09:00:00.000Z",
    lastNotificationStatus: "push sent",
    notification: {
      title: "Jalopy Alerts: 2006–2012 HONDA CIVIC",
      body: "2 new arrivals at CALDWELL, TRUSTY'S. 2010 row 31 (JJ CALDWELL) — 2026-03-24; 2011 row B7 (TRUSTY'S) — 2026-03-24",
      newVehicleKeys: ["1021:2010:HONDA:CIVIC:31", "trusty:2011:HONDA:CIVIC:B7"],
    },
    rows: [
      { yardId: "1021", yardName: "CALDWELL", year: 2010, make: "HONDA", model: "CIVIC", row: "31" },
      { yardId: "trusty", yardName: "TRUSTY'S", year: 2011, make: "HONDA", model: "CIVIC", row: "B7" },
      { yardId: "1119", yardName: "GARDEN CITY", year: 2008, make: "HONDA", model: "CIVIC", row: "66" },
    ],
  },
];

const els = {
  alertsList: document.getElementById("alertsList"),
  results: document.getElementById("results"),
  searchContext: document.getElementById("searchContext"),
  notificationTitle: document.getElementById("notificationTitle"),
  notificationBody: document.getElementById("notificationBody"),
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inventoryKeyForRow(row) {
  return [
    String(row?.yardId || "").trim(),
    String(row?.year || "").trim(),
    String(row?.make || "").trim().toUpperCase(),
    String(row?.model || "").trim().toUpperCase(),
    String(row?.row || "").trim().toUpperCase(),
  ].join(":");
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function renderAlerts(alerts) {
  els.alertsList.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const a of alerts) {
    const row = document.createElement("div");
    row.className = "alert-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");

    const left = document.createElement("div");
    const headline = document.createElement("div");
    headline.className = "alert-primary";
    headline.textContent = `${a.VehicleMake} — ${a.VehicleModel} (${a.VehicleMinYear}–${a.VehicleMaxYear})`;

    const meta = document.createElement("div");
    meta.className = "alert-meta";
    meta.textContent = `Created ${formatTimestamp(a.createdAt)} • Last notified ${formatTimestamp(a.lastNotifiedAt)} (${a.lastNotificationStatus})`;

    left.appendChild(headline);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "alert-actions";

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = "Demo";
    actions.appendChild(chip);

    row.appendChild(left);
    row.appendChild(actions);

    row.addEventListener("click", () => selectAlert(a));
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        selectAlert(a);
      }
    });

    frag.appendChild(row);
  }

  els.alertsList.appendChild(frag);
}

function renderRows(rows, newVehicleKeys = []) {
  const keys = new Set(newVehicleKeys);
  els.results.innerHTML = "";

  for (const r of rows) {
    const isNew = keys.has(inventoryKeyForRow(r));
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.yardName)}</td>
      <td>${escapeHtml(r.year)}</td>
      <td>${escapeHtml(r.make)}</td>
      <td>${escapeHtml(r.model)}${isNew ? ' <span class="new-arrival-tag">NEW</span>' : ""}</td>
      <td>${escapeHtml(r.row)}</td>
    `;
    els.results.appendChild(tr);
  }
}

function selectAlert(alert) {
  els.searchContext.textContent = `Showing demo search: ${alert.VehicleMake} ${alert.VehicleModel} (${alert.VehicleMinYear}–${alert.VehicleMaxYear})`;
  els.notificationTitle.textContent = alert.notification.title;
  els.notificationBody.textContent = alert.notification.body;
  renderRows(alert.rows, alert.notification.newVehicleKeys);
}

renderAlerts(DEMO_ALERTS);
selectAlert(DEMO_ALERTS[0]);
