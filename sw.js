// Guarda la página en el celular para que abra aunque no haya internet.
// Al cambiar el lector (carpeta lector/) hay que cambiar el nombre del caché.
const CACHE = "pistoleo-v1";
const BASICOS = ["./", "index.html", "app.js", "manifest.webmanifest", "icono-192.png", "icono-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function guardar(pedido, respuesta) {
  if (respuesta.ok) {
    const copia = respuesta.clone();
    caches.open(CACHE).then((c) => c.put(pedido, copia));
  }
  return respuesta;
}

self.addEventListener("fetch", (e) => {
  const pedido = e.request;
  const url = new URL(pedido.url);
  if (pedido.method !== "GET" || url.origin !== location.origin) return;  // los envíos a Google pasan directo
  if (url.pathname.includes("/lector/")) {
    // el lector pesa 1 MB y no cambia: primero lo guardado
    e.respondWith(caches.match(pedido).then((r) => r || fetch(pedido).then((resp) => guardar(pedido, resp))));
    return;
  }
  // la página: primero internet (así llegan los cambios); sin internet, lo guardado
  e.respondWith(fetch(pedido).then((resp) => guardar(pedido, resp))
    .catch(() => caches.match(pedido, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
});
