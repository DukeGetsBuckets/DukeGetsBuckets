// Cubefire Arena service worker: shows "come play" notifications and opens the game
// on the right map when one is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || "Cubefire Arena", {
    body: d.body || "Someone is playing. Tap to join!",
    icon: "icon-192.png", badge: "icon-192.png", tag: "cfa-call", renotify: true,
    data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of open) {
      if (new URL(c.url).origin !== url.origin) continue;
      await c.focus();
      c.postMessage({ join: url.search });   // the open game picks the map and party
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
