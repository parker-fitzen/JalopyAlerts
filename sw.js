const ALERTS_BASE = "https://jalprox.parkfitz.workers.dev/alerts";

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || self.location.origin;
  event.waitUntil(clients.openWindow(url));
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
