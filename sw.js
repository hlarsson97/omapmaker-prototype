// Bump for every release that changes app-shell resources.
const CACHE = 'omapmaker-shell-bridge-4';
const SHELL = ['index.html', 'field.html', 'home.js', 'home.css', 'app.mjs', 'styles.css', 'team.css', 'isom_symbols.js', 'isom_renderer.js'];
const MODULES = ['team_sync','team_home','team_panel','offline','viewport_layers','layer_presentation','contour_presentation','utils','generation_settings','indexeddb_store','map_setup','map_layer_api','generated_buildings','generated_paved_areas','generated_roads','generated_infrastructure','bridge_tunnel','generated_land_cover','magnetic_north','map_orientation','smooth_rotation','local_map_objects','map_objects','popup_stack','symbol_object_settings','field_survey','account_api'];
const EXTERNAL = ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css','https://unpkg.com/leaflet@1.9.4/dist/leaflet.js','https://unpkg.com/@tomickigrzegorz/leaflet-rotate@0.2.4/dist/leaflet-rotate.umd.min.js'];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll([...SHELL, ...MODULES.map(name => `js/${name}.mjs`)]);
  // Fetch as CORS so a failed library download cannot masquerade as a cached error.
  await Promise.all(EXTERNAL.map(async url => {const response = await fetch(url, {mode:'cors'});if(!response.ok)throw new Error('Library unavailable');await cache.put(url,response);}));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('omapmaker-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const sameOrigin = url.origin === self.location.origin;
  const relative = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (!(sameOrigin && (SHELL.includes(relative) || relative === '' || MODULES.some(name => relative === `js/${name}.mjs`))) && !EXTERNAL.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      // Network-first: published updates are visible immediately while online.
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(request, {ignoreSearch:true}) || (relative === '' ? await cache.match('index.html') : null);
      if (cached) return cached;
      throw error;
    }
  })());
});
