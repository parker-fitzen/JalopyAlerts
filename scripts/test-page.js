(function initTestPage() {
  const fakeNotification = {
    title: "Jalopy Alerts: 2006–2013 TOYOTA PRIUS",
    body: "1 new arrival at JJ BOISE. 2010 row 42 (JJ BOISE) — 2026-03-25",
    date: "2026-03-25",
    row: "42",
    year: 2010,
  };

  const fakeRows = [
    { yardName: "JJ BOISE", year: 2010, make: "TOYOTA", model: "PRIUS", row: "42", isNew: true },
    { yardName: "JJ CALDWELL", year: 2009, make: "TOYOTA", model: "PRIUS", row: "12", isNew: false },
    { yardName: "TRUSTY'S", year: 2008, make: "TOYOTA", model: "PRIUS", row: "7", isNew: false },
  ];

  const fakeAlerts = [
    {
      make: "TOYOTA",
      model: "PRIUS",
      years: "2006–2013",
      createdAt: "3/23/2026, 8:05:00 PM",
      lastNotifiedAt: "3/25/2026, 9:00:00 AM",
      status: "push sent",
    },
    {
      make: "HONDA",
      model: "CIVIC",
      years: "2010–2016",
      createdAt: "3/22/2026, 7:14:00 PM",
      lastNotifiedAt: "never",
      status: "No notifications sent yet.",
    },
    {
      make: "SUBARU",
      model: "(any model)",
      years: "from 2005",
      createdAt: "3/20/2026, 10:15:00 AM",
      lastNotifiedAt: "3/24/2026, 9:00:00 AM",
      status: "push sent",
    },
  ];

  renderNotification(fakeNotification);
  renderRows(fakeRows);
  renderAlerts(fakeAlerts);
})();

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderNotification(n) {
  const el = document.getElementById("notificationPreview");
  if (!el) return;
  el.innerHTML = `
    <div style="font-weight: 800; margin-bottom: 6px;">${escapeHtml(n.title)}</div>
    <div style="margin-bottom: 6px;">${escapeHtml(n.body)}</div>
    <div class="muted">Arrival date: ${escapeHtml(n.date)} • Year: ${escapeHtml(n.year)} • Row: ${escapeHtml(n.row)}</div>
  `;
}

function renderRows(rows) {
  const body = document.getElementById("testResults");
  if (!body) return;
  body.innerHTML = "";

  const fragment = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    const newTag = r.isNew ? ' <span class="new-arrival-tag">NEW</span>' : "";
    tr.innerHTML = `
      <td>${escapeHtml(r.yardName)}</td>
      <td>${escapeHtml(r.year)}</td>
      <td>${escapeHtml(r.make)}</td>
      <td>${escapeHtml(r.model)}${newTag}</td>
      <td>${escapeHtml(r.row)}</td>
    `;
    fragment.appendChild(tr);
  }

  body.appendChild(fragment);
}

function renderAlerts(alerts) {
  const list = document.getElementById("testAlerts");
  if (!list) return;
  list.innerHTML = "";

  const fragment = document.createDocumentFragment();

  for (const alert of alerts) {
    const row = document.createElement("div");
    row.className = "alert-row";

    const left = document.createElement("div");
    const headline = document.createElement("div");
    headline.className = "alert-primary";
    headline.textContent = `${alert.make} — ${alert.model} (${alert.years})`;

    const meta = document.createElement("div");
    meta.className = "alert-meta";
    meta.textContent = `Push subscription: set • Created ${alert.createdAt}`;

    const status = document.createElement("div");
    status.className = "alert-meta";
    status.textContent = `Last notified: ${alert.lastNotifiedAt} (${alert.status})`;

    left.appendChild(headline);
    left.appendChild(meta);
    left.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "alert-actions";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = alert.status === "push sent" ? "Active" : "New";
    actions.appendChild(chip);

    row.appendChild(left);
    row.appendChild(actions);
    fragment.appendChild(row);
  }

  list.appendChild(fragment);
}
