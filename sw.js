const ALERTS_BASE = "https://jalprox.parkfitz.workers.dev/alerts";

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event.notification?.data || {}));
});

async function handlePush() {
  try {
    const reg = await self.registration.pushManager.getSubscription();
    if (!reg) return;
    const resp = await fetch(`${ALERTS_BASE}/notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: reg.endpoint }),
    });
    const data = await resp.json().catch(() => ({}));
    const n = data?.notification || {};
    await self.registration.showNotification(n.title || "Jalopy Alerts", {
      body: n.body || "New vehicles found.",
      data: n.data || {},
    });
  } catch (err) {
    console.error("push handler failed", err);
  }
}

async function handleNotificationClick(data) {
  const targetPath = data?.url || `/?alertId=${encodeURIComponent(data?.alertId || "")}`;
  const targetUrl = new URL(targetPath, self.location.origin).toString();
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });

  for (const client of windows) {
    try {
      const current = new URL(client.url);
      if (current.origin === self.location.origin) {
        await client.focus();
        client.postMessage({ type: "jalopy-alert-open", payload: data });
        return;
      }
    } catch (_err) {
      // ignore malformed client urls
    }
  }

  const opened = await clients.openWindow(targetUrl);
  if (opened) {
    opened.postMessage({ type: "jalopy-alert-open", payload: data });
  }
}
