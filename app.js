"use strict";
// Pistoleo de inventario desde el celular.
//
// Cada código se guarda al instante en el celular y se envía a la pestaña
// Pistoleo de la hoja de la tienda (a través del Apps Script del dueño de las
// hojas). Sin internet las lecturas esperan y se envían solas al volver la
// conexión; un reintento nunca las duplica porque cada una lleva su ID.
// El programa del PC lee esa pestaña cada pocos segundos y las suma al inventario.

const FORMATOS_BARRAS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"];
const MS_MISMO_CODIGO = 1500;   // un código que sigue frente a la cámara no se cuenta otra vez
const MS_ENTRE_LECTURAS = 700;  // pausa mínima entre dos lecturas con la cámara
const MS_DOBLE = 3000;          // aviso si el mismo código se lee dos veces seguidas en este lapso
const MS_PING = 20000;          // sin nada que enviar, cada cuánto se pregunta por el inventario
const MS_REINTENTO_MAX = 30000;
const POR_ENVIO = 200;
const MAX_LECTURAS = 5000;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- memoria del celular
const almacen = {
  leer(clave, porDefecto) {
    try {
      const v = localStorage.getItem("pistoleo." + clave);
      return v === null ? porDefecto : JSON.parse(v);
    } catch (e) {
      return porDefecto;
    }
  },
  guardar(clave, valor) {
    try {
      localStorage.setItem("pistoleo." + clave, JSON.stringify(valor));
      return true;
    } catch (e) {
      return false;
    }
  },
  borrar(clave) {
    try { localStorage.removeItem("pistoleo." + clave); } catch (e) { /* nada */ }
  },
};

function aleatorio(n) {
  let t = "";
  while (t.length < n) t += Math.random().toString(36).slice(2);
  return t.slice(0, n);
}

let config = almacen.leer("config", null);   // {h: hoja, f: firma, t: tienda, s: Apps Script}
let equipo = almacen.leer("equipo", null);
if (!equipo || !/^[a-z0-9]{5}$/.test(equipo.id || "")) {
  equipo = { id: aleatorio(5), nombre: "" };
  almacen.guardar("equipo", equipo);
}
let datos = { inventario: "", lista: [] };    // lecturas de la tienda actual
let stock = vacioStock();
const red = { estado: "inicio", total: null, enCurso: null, error: "" };
let contadorId = 0;

// ---------------------------------------------------------------- normalización (igual que el PC)
function normalizarCodigo(valor) {
  let t = String(valor == null ? "" : valor).replace(/[\s\p{C}]/gu, "").replace(/^'+/, "").toUpperCase();
  if (!t) return "";
  if (/^[0-9]+([.,][0-9]+)?E[+-]?[0-9]+$/.test(t)) return null;  // 4,05981E+12: ilegible
  if (/^[0-9]+\.0+$/.test(t)) t = t.split(".")[0];
  if (/^[0-9]+$/.test(t)) t = t.replace(/^0+/, "") || "0";
  return t;
}

function normalizarMaterial(valor) {
  let t = String(valor == null ? "" : valor).replace(/\s+/g, "").toUpperCase();
  if (/^[0-9]+$/.test(t)) t = t.replace(/^0+/, "") || "0";
  return t;
}

function digitoOk(codigo, formato) {
  // EAN-13, EAN-8 y UPC-A traen un dígito verificador: un código mal leído se descarta
  if (!["ean_13", "ean_8", "upc_a"].includes(formato) || !/^[0-9]{8,14}$/.test(codigo)) return true;
  const d = codigo.split("").map(Number);
  const control = d.pop();
  let suma = 0;
  d.reverse().forEach((n, i) => { suma += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (suma % 10)) % 10 === control;
}

// ---------------------------------------------------------------- tienda y lecturas
function configDesdeTexto(texto) {
  try {
    const url = new URL(texto, location.href);
    const p = new URLSearchParams(url.hash.slice(1));
    const c = { h: p.get("h") || "", f: p.get("f") || "", t: (p.get("t") || "").slice(0, 60), s: p.get("s") || "" };
    if (/^[A-Za-z0-9_-]{20,80}$/.test(c.h) && /^[0-9a-f]{24}$/.test(c.f) && /^[A-Za-z0-9_-]{20,200}$/.test(c.s)) {
      return c;
    }
  } catch (e) { /* no es un enlace */ }
  return null;
}

function aplicarConfig(c) {
  config = c;
  almacen.guardar("config", c);
  red.estado = "inicio";
  red.total = null;
  red.enCurso = null;
  red.error = "";
  cargarTienda();
}

function cargarTienda() {
  const guardados = almacen.leer("lecturas." + config.h, null);
  datos = guardados && Array.isArray(guardados.lista) ? guardados : { inventario: "", lista: [] };
  const s = almacen.leer("stock." + config.h, null);
  ponerStock(s ? s.version : "", s ? s.filas : []);
  pintarTodo();
  programarEnvio(50);
}

function guardarDatos() {
  if (!config) return true;
  if (datos.lista.length > MAX_LECTURAS) {
    // se olvidan las más antiguas que ya están en la hoja
    let sobran = datos.lista.length - MAX_LECTURAS;
    datos.lista = datos.lista.filter((l) => !(sobran > 0 && l.env && (!l.anul || l.anulEnv) && sobran--));
  }
  const ok = almacen.guardar("lecturas." + config.h, datos);
  $("aviso-guardado").classList.toggle("oculto", ok);
  return ok;
}

function vigentes() {
  return datos.lista.filter((l) => !l.anul);
}

function pendientes() {
  return datos.lista.filter((l) => !l.env && !l.anul);
}

function anulacionesPendientes() {
  // ya llegó a la hoja y después se deshizo: hay que marcarla ANULADA allá
  return datos.lista.filter((l) => l.anul && l.env && !l.anulEnv);
}

function nuevoId() {
  contadorId = (contadorId + 1) % 1296;
  return "m" + equipo.id + Date.now().toString(36) + contadorId.toString(36);
}

function horaTexto(f) {
  const d = (n) => String(n).padStart(2, "0");
  return `${d(f.getDate())}-${d(f.getMonth() + 1)}-${f.getFullYear()} ${d(f.getHours())}:${d(f.getMinutes())}:${d(f.getSeconds())}`;
}

function nombreEquipo() {
  return (equipo.nombre || "").trim() || equipo.id.toUpperCase();
}

// ---------------------------------------------------------------- stock de la tienda
function vacioStock() {
  return { version: "", filas: [], porCodigo: new Map(), porMaterial: new Map() };
}

function ponerStock(version, filas) {
  stock = vacioStock();
  stock.version = version || "";
  stock.filas = Array.isArray(filas) ? filas : [];
  stock.filas.forEach((f, i) => {
    const c = normalizarCodigo(f[0]);
    if (c && !stock.porCodigo.has(c)) stock.porCodigo.set(c, i);
    const m = normalizarMaterial(f[1]);
    if (m && !stock.porMaterial.has(m)) stock.porMaterial.set(m, i);
  });
}

function buscar(normal) {
  if (!normal) return null;
  let i = stock.porCodigo.get(normal);
  if (i === undefined) i = stock.porMaterial.get(normalizarMaterial(normal));  // SKU escrito a mano
  if (i === undefined) return null;
  const f = stock.filas[i];
  return { material: normalizarMaterial(f[1]), descripcion: f[2] || f[1] || "", talla: f[3] || "", libre: f[4] };
}

let cargandoStock = false;
async function cargarStock(avisar) {
  if (cargandoStock || !config) return;
  cargandoStock = true;
  const hoja = config.h;
  try {
    const r = await llamar("celular_stock", {});
    if (!config || config.h !== hoja) return;
    ponerStock(r.stock, r.filas);
    if (!almacen.guardar("stock." + hoja, { version: stock.version, filas: stock.filas })) {
      almacen.borrar("stock." + hoja);  // no cupo: se usa solo mientras la página está abierta
    }
    if (avisar) {
      mostrarResultado("info", "Lista de productos actualizada",
        stock.filas.length ? `${num(stock.filas.length)} productos.` : "La tienda todavía no tiene el Excel de SAP cargado en el PC.");
    }
  } catch (e) {
    if (avisar) mostrarResultado("error", "No se pudo actualizar la lista de productos", e.message);
  } finally {
    cargandoStock = false;
    pintarContadores();
  }
}

// ---------------------------------------------------------------- conexión con la hoja
async function llamar(accion, extra) {
  const control = new AbortController();
  const plazo = setTimeout(() => control.abort(), 45000);
  let resp;
  try {
    resp = await fetch(`https://script.google.com/macros/s/${config.s}/exec`, {
      method: "POST",
      // text/plain: así el navegador no hace la consulta previa que Google no responde
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ accion, hoja: config.h, firma: config.f }, extra)),
      signal: control.signal,
      cache: "no-store",
    });
  } catch (e) {
    throw Object.assign(new Error("Sin conexión a internet."), { red: true });
  } finally {
    clearTimeout(plazo);
  }
  let r = null;
  try { r = await resp.json(); } catch (e) { /* no era JSON */ }
  if (!r || typeof r !== "object") {
    throw new Error(resp.status === 404 ? "No se encontró el Apps Script de la tienda."
      : `Google no respondió bien (error ${resp.status}).`);
  }
  if (!r.ok) {
    if (r.error === "Clave incorrecta.") {
      throw new Error("Falta actualizar el Apps Script a la versión 2 (ver APPS_SCRIPT_TIENDAS.txt).");
    }
    throw Object.assign(new Error(r.error || "Error desconocido."), { motivo: r.motivo, reintentar: r.reintentar });
  }
  return r;
}

let enviando = false;
let temporizadorEnvio = null;
let retraso = 2000;

function programarEnvio(ms) {
  clearTimeout(temporizadorEnvio);
  temporizadorEnvio = setTimeout(enviar, ms);
}

async function enviar() {
  clearTimeout(temporizadorEnvio);
  if (!config || enviando || red.estado === "enlace") return;
  const hoja = config.h;
  const lecturas = pendientes().slice(0, POR_ENVIO);
  const anulaciones = anulacionesPendientes().slice(0, POR_ENVIO);
  enviando = true;
  pintarRed();
  try {
    const r = await llamar("celular_enviar", {
      lecturas: lecturas.map((l) => ({ id: l.id, codigo: l.codigo, hora: l.hora })),
      anular: anulaciones.map((l) => l.id),
      equipo: nombreEquipo(),
    });
    if (!config || config.h !== hoja) return;  // se cambió de tienda mientras tanto
    const llegaron = new Set(r.confirmadas || []);
    const anuladas = new Set(r.anuladas || []);
    datos.lista.forEach((l) => {
      if (llegaron.has(l.id)) l.env = 1;  // si se deshizo mientras viajaba, se anula en el próximo envío
      if (anuladas.has(l.id)) l.anulEnv = 1;
    });
    red.estado = "ok";
    red.error = "";
    red.total = typeof r.total === "number" ? r.total : null;
    revisarInventario(r.en_curso || "");
    guardarDatos();
    retraso = 2000;
    if ((r.stock || "") !== stock.version || (!stock.filas.length && r.stock)) cargarStock(false);
  } catch (e) {
    if (e.motivo === "enlace") {
      red.estado = "enlace";
    } else {
      red.estado = e.red || navigator.onLine === false ? "sin_red" : "error";
      retraso = Math.min(MS_REINTENTO_MAX, retraso * 2);
    }
    red.error = e.message;
  } finally {
    enviando = false;
    pintarTodo();
    if (red.estado !== "enlace" && config) {
      const quedan = pendientes().length + anulacionesPendientes().length;
      programarEnvio(red.estado === "ok" ? (quedan ? 300 : MS_PING) : retraso);
    }
  }
}

function revisarInventario(enCurso) {
  red.enCurso = enCurso;
  const m = /\d{8}-\d{6}/.exec(enCurso);
  const id = m ? m[0] : "";
  if (id && id !== datos.inventario) {
    if (datos.inventario) {
      // empezó otro inventario: lo de antes ya quedó en el anterior
      datos.lista = datos.lista.filter((l) => !l.env && !l.anul);
    }
    datos.inventario = id;
  }
}

// ---------------------------------------------------------------- lecturas
let ultimaMostrada = null;

function anotar(texto) {
  const codigo = String(texto == null ? "" : texto).replace(/\s+/g, "").replace(/^['’`´]+/, "");
  if (!codigo || !config) return;
  const normal = normalizarCodigo(codigo);
  if (normal === null || codigo.length < 4 || codigo.length > 40) {
    sonido("error");
    mostrarResultado("error", "No se pudo leer el código", "No se anotó. Vuelve a intentarlo.", codigo.slice(0, 40));
    return;
  }
  const ahora = Date.now();
  const anterior = vigentes().pop();
  const doble = anterior && normalizarCodigo(anterior.codigo) === normal && ahora - anterior.t < MS_DOBLE;
  const lectura = { id: nuevoId(), codigo, hora: horaTexto(new Date(ahora)), t: ahora, env: 0, anul: 0, anulEnv: 0 };
  datos.lista.push(lectura);
  guardarDatos();
  ultimaMostrada = lectura.id;
  destello();

  const p = buscar(normal);
  if (!p) {
    if (stock.filas.length) {
      sonido("error");
      mostrarResultado("error", "No está en el Excel de SAP",
        "Quedó anotado como «no encontrado». Revisa la etiqueta del producto.", codigo);
    } else {
      sonido("ok");
      mostrarResultado("ok", "Código anotado", "Todavía no se carga la lista de productos de la tienda.", codigo);
    }
  } else {
    const aqui = vigentes().filter((l) => {
      const q = buscar(normalizarCodigo(l.codigo));
      return q && q.material === p.material;
    }).length;
    const detalle = `Talla ${p.talla || "—"}  ·  Sistema: ${num(p.libre)}\nEn este celular: ${aqui}`;
    if (doble) {
      sonido("aviso");
      mostrarResultado("aviso", p.descripcion,
        detalle + "\nSe leyó dos veces seguidas. Si fue sin querer, toca «Deshacer último».", codigo);
    } else {
      sonido("ok");
      mostrarResultado("ok", p.descripcion, detalle, codigo);
    }
  }
  pintarContadores();
  programarEnvio(300);
}

function deshacer() {
  const l = vigentes().pop();
  if (!l) {
    mostrarResultado("info", "No hay lecturas para deshacer", "");
    return;
  }
  anularLectura(l);
  sonido("aviso");
  const p = buscar(normalizarCodigo(l.codigo));
  mostrarResultado("aviso", "Se quitó la última lectura", p ? p.descripcion : "", l.codigo, "←");
}

function anularLectura(l) {
  l.anul = 1;
  guardarDatos();
  pintarContadores();
  programarEnvio(300);
}

// ---------------------------------------------------------------- cámara
let stream = null;
let pista = null;
let modoCamara = null;
let ciclo = 0;
let detector = null;
let usaPonyfill = false;
let linterna = false;
let abriendo = null;
const detectores = {};
const lienzo = document.createElement("canvas");
const pincel = lienzo.getContext("2d", { willReadFrequently: true });

let cargaPonyfill = null;
function cargarPonyfill() {
  if (!cargaPonyfill) {
    cargaPonyfill = new Promise((resolver, rechazar) => {
      const s = document.createElement("script");
      s.src = "lector/ponyfill.js";
      s.onload = () => {
        try {
          // el lector viaja junto a la página: no depende de otros sitios
          BarcodeDetectionAPI.prepareZXingModule({
            overrides: {
              locateFile: (ruta, prefijo) => (ruta.endsWith(".wasm") ? new URL("lector/" + ruta, location.href).href : prefijo + ruta),
            },
          });
          resolver();
        } catch (e) {
          rechazar(e);
        }
      };
      s.onerror = () => { cargaPonyfill = null; rechazar(new Error("No se pudo cargar el lector")); };
      document.head.appendChild(s);
    });
  }
  return cargaPonyfill;
}

async function obtenerDetector(modo) {
  if (detectores[modo]) return detectores[modo];
  const formatos = modo === "qr" ? ["qr_code"] : FORMATOS_BARRAS;
  let d = null;
  if ("BarcodeDetector" in window) {
    try {
      const soportados = await window.BarcodeDetector.getSupportedFormats();
      const usar = formatos.filter((f) => soportados.includes(f));
      if (usar.includes(modo === "qr" ? "qr_code" : "ean_13")) d = { lector: new window.BarcodeDetector({ formats: usar }), ponyfill: false };
    } catch (e) { /* se usa el lector incluido */ }
  }
  if (!d) {
    await cargarPonyfill();
    d = { lector: new BarcodeDetectionAPI.BarcodeDetector({ formats: formatos }), ponyfill: true };
  }
  detectores[modo] = d;
  return d;
}

function mensajeCamara(texto) {
  $("camara-msg").textContent = texto || "";
}

function textoErrorCamara(e) {
  const nombre = e && e.name;
  if (nombre === "NotAllowedError" || nombre === "SecurityError") {
    return "No hay permiso para usar la cámara. Toca el candado junto a la dirección → Permisos → Cámara → Permitir. También puedes escribir los códigos.";
  }
  if (nombre === "NotFoundError" || nombre === "OverconstrainedError") return "No se encontró la cámara del celular.";
  if (nombre === "NotReadableError") return "Otra app está usando la cámara. Ciérrala y toca aquí para reintentar.";
  return "No se pudo abrir la cámara. Toca aquí para reintentar.";
}

async function abrirCamara(modo, hueco) {
  while (abriendo) {
    try { await abriendo; } catch (e) { /* se intenta de nuevo */ }
  }
  modoCamara = modo;
  const camara = $("camara");
  camara.dataset.modo = modo;
  $(hueco).appendChild(camara);
  abriendo = (async () => {
    const mio = ++ciclo;
    mensajeCamara("Abriendo la cámara…");
    try {
      const d = await obtenerDetector(modo);
      detector = d.lector;
      usaPonyfill = d.ponyfill;
    } catch (e) {
      mensajeCamara("Este celular no puede leer códigos con la cámara. Usa «Escribir código».");
      return false;
    }
    if (!stream) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        mensajeCamara("Este navegador no deja usar la cámara. Abre la página en Chrome.");
        return false;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (e) {
        mensajeCamara(textoErrorCamara(e));
        return false;
      }
      const video = $("video");
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* autoplay: se reproduce al tocar */ }
      pista = stream.getVideoTracks()[0];
      try { await pista.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) { /* no todas lo tienen */ }
      const capacidades = pista.getCapabilities ? pista.getCapabilities() : {};
      $("btn-linterna").classList.toggle("oculto", !capacidades.torch);
    }
    if (mio !== ciclo) return false;  // se cerró o se cambió de modo mientras tanto
    mensajeCamara(modo === "qr" ? "Apunta al código QR de la pantalla del PC" : "");
    detectar(mio);
    return true;
  })();
  try {
    return await abriendo;
  } finally {
    abriendo = null;
  }
}

function cerrarCamara() {
  ciclo++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  pista = null;
  linterna = false;
  $("btn-linterna").textContent = "Encender linterna";
  $("btn-linterna").classList.add("oculto");
  $("video").srcObject = null;
  modoCamara = null;
}

function recortar(video) {
  // solo lo que está dentro del recuadro: así no se lee la caja de al lado
  const caja = $("camara").getBoundingClientRect();
  const guia = $("guia").getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const escala = Math.max(caja.width / vw, caja.height / vh);
  const ox = (caja.width - vw * escala) / 2;
  const oy = (caja.height - vh * escala) / 2;
  let w = guia.width / escala;
  let h = guia.height / escala;
  let x = (guia.left - caja.left - ox) / escala - w * 0.08;
  let y = (guia.top - caja.top - oy) / escala - h * 0.15;
  w *= 1.16;
  h *= 1.3;
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.max(1, Math.min(vw - x, w));
  h = Math.max(1, Math.min(vh - y, h));
  const f = Math.min(1, 1000 / w);
  lienzo.width = Math.round(w * f);
  lienzo.height = Math.round(h * f);
  pincel.drawImage(video, x, y, w, h, 0, 0, lienzo.width, lienzo.height);
  return lienzo;
}

async function detectar(mio) {
  if (mio !== ciclo) return;
  const video = $("video");
  if (video.readyState >= 2 && video.videoWidth && document.visibilityState === "visible") {
    try {
      const resultados = await detector.detect(recortar(video));
      if (mio !== ciclo) return;
      alDetectar(resultados || []);
    } catch (e) { /* un cuadro que falla no importa */ }
  }
  setTimeout(() => detectar(mio), usaPonyfill ? 120 : 80);
}

const vistos = new Map();  // código ya contado -> última vez que se vio
let ultimaCamara = 0;

function alDetectar(resultados) {
  const ahora = performance.now();
  if (modoCamara === "qr") {
    for (const r of resultados) {
      const c = configDesdeTexto(String(r.rawValue || ""));
      if (c) {
        vinculado(c);
        return;
      }
    }
    if (resultados.length) mensajeCamara("Ese código QR no es el del programa del PC.");
    return;
  }
  let elegido = null;
  for (const r of resultados) {
    const codigo = String(r.rawValue || "").trim();
    if (!codigo || (r.format && !FORMATOS_BARRAS.includes(r.format)) || !digitoOk(codigo, r.format)) continue;
    const visto = vistos.get(codigo);
    if (visto !== undefined && ahora - visto < MS_MISMO_CODIGO) {
      vistos.set(codigo, ahora);  // sigue frente a la cámara
      continue;
    }
    if (!elegido) elegido = codigo;
  }
  if (elegido && ahora - ultimaCamara >= MS_ENTRE_LECTURAS) {
    vistos.set(elegido, ahora);
    ultimaCamara = ahora;
    anotar(elegido);
  }
  if (vistos.size > 100) vistos.forEach((t, c) => { if (ahora - t > 10000) vistos.delete(c); });
}

function destello() {
  const camara = $("camara");
  camara.classList.add("leido");
  setTimeout(() => camara.classList.remove("leido"), 250);
}

async function alternarLinterna() {
  if (!pista) return;
  try {
    await pista.applyConstraints({ advanced: [{ torch: !linterna }] });
    linterna = !linterna;
    $("btn-linterna").textContent = linterna ? "Apagar linterna" : "Encender linterna";
  } catch (e) {
    $("btn-linterna").classList.add("oculto");
  }
}

// ---------------------------------------------------------------- sonido, vibración y pantalla
let audio = null;

function prepararAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch (e) { /* sin sonido */ }
}

function tono(frecuencia, inicio, duracion) {
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = "square";
  o.frequency.value = frecuencia;
  g.gain.setValueAtTime(0.18, inicio);
  g.gain.exponentialRampToValueAtTime(0.001, inicio + duracion);
  o.connect(g).connect(audio.destination);
  o.start(inicio);
  o.stop(inicio + duracion + 0.02);
}

function sonido(tipo) {
  const patrones = { ok: [60], error: [220, 90, 220], aviso: [90, 70, 90] };
  const tocado = !navigator.userActivation || navigator.userActivation.hasBeenActive;  // si no, Chrome la bloquea
  try { if (navigator.vibrate && tocado) navigator.vibrate(patrones[tipo] || [60]); } catch (e) { /* nada */ }
  if (!audio) return;
  try {
    const t = audio.currentTime + 0.01;
    if (tipo === "ok") {
      tono(1760, t, 0.09);
    } else if (tipo === "error") {
      tono(220, t, 0.2);
      tono(170, t + 0.26, 0.28);
    } else {
      tono(880, t, 0.08);
      tono(880, t + 0.15, 0.08);
    }
  } catch (e) { /* sin sonido */ }
}

let bloqueoPantalla = null;
async function mantenerPantalla() {
  try {
    if ("wakeLock" in navigator && !bloqueoPantalla && document.visibilityState === "visible") {
      bloqueoPantalla = await navigator.wakeLock.request("screen");
      bloqueoPantalla.addEventListener("release", () => { bloqueoPantalla = null; });
    }
  } catch (e) { /* la pantalla se apagará sola */ }
}

// ---------------------------------------------------------------- pantalla
let vista = null;

function mostrarVista(nombre) {
  vista = nombre;
  ["vincular", "inicio", "pistoleo"].forEach((v) => $("vista-" + v).classList.toggle("oculto", v !== nombre));
  if (nombre !== "pistoleo" && nombre !== "vincular") cerrarCamara();
  if (nombre === "vincular") {
    cerrarCamara();
    $("hueco-vincular").classList.add("oculto");
    $("btn-vincular").classList.remove("oculto");
    $("btn-vincular-volver").classList.toggle("oculto", !config);
  }
  if (nombre === "inicio") $("inp-nombre").value = equipo.nombre || "";
  pintarTodo();
  window.scrollTo(0, 0);
}

function mostrarResultado(tipo, titulo, detalle, codigo, icono) {
  const caja = $("resultado");
  caja.className = "resultado " + tipo;
  $("res-icono").textContent = icono || { ok: "✔", error: "✖", aviso: "⚠", info: "ℹ" }[tipo] || "";
  $("res-titulo").textContent = titulo || "";
  $("res-detalle").textContent = detalle || "";
  $("res-codigo").textContent = codigo ? "Código " + codigo : "";
}

function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("es-CL") : String(n == null ? "" : n);
}

function pintarTodo() {
  const tienda = config ? config.t || "Tienda" : "";
  $("tienda").textContent = tienda;
  $("inicio-tienda").textContent = tienda ? "Tienda: " + tienda : "";
  $("btn-menu").classList.toggle("oculto", !config || vista === "vincular");
  pintarRed();
  pintarContadores();
}

function pintarRed() {
  const e = $("estado-red");
  const aviso = $("aviso-inventario");
  if (!config || vista === "vincular") {
    e.classList.add("oculto");
    aviso.classList.add("oculto");
    return;
  }
  const quedan = pendientes().length + anulacionesPendientes().length;
  let texto;
  let clase;
  if (red.estado === "enlace") {
    texto = "● El enlace de la tienda ya no sirve: toca aquí y vuelve a escanear el QR del PC";
    clase = "mal";
  } else if (enviando && quedan) {
    texto = `● Enviando ${quedan}…`;
    clase = "pendiente";
  } else if (red.estado === "sin_red") {
    texto = `● Sin internet${quedan ? ` · ${quedan} por enviar (se envían solas)` : ""}`;
    clase = "mal";
  } else if (red.estado === "error") {
    texto = `● No se pudo enviar${quedan ? ` · ${quedan} por enviar` : ""} · toca para ver por qué`;
    clase = "mal";
  } else if (red.estado === "ok") {
    texto = quedan ? `● ${quedan} por enviar…` : "● Conectado · todo enviado";
    clase = quedan ? "pendiente" : "ok";
  } else {
    texto = "◌ Conectando con la hoja de la tienda…";
    clase = "";
  }
  e.textContent = texto;
  e.className = clase;
  aviso.classList.toggle("oculto", !(red.estado === "ok" && red.enCurso === ""));
}

function pintarContadores() {
  const c = $("contadores");
  if (!config) {
    c.textContent = "";
    return;
  }
  const mias = vigentes().length;
  c.innerHTML = "";
  c.append("En este celular: ");
  const b = document.createElement("b");
  b.textContent = num(mias);
  c.append(b);
  if (red.total !== null) c.append(`  ·  En la hoja (todos): ${num(red.total)}`);
  if (!stock.filas.length && red.estado === "ok") c.append("\nSin lista de productos todavía");
}

function pintarLecturas() {
  const lista = $("lista-lecturas");
  lista.innerHTML = "";
  const todas = datos.lista.slice().reverse();
  $("lecturas-resumen").textContent = todas.length
    ? `${num(vigentes().length)} lectura(s) en este celular, la más reciente arriba.`
    : "Todavía no hay lecturas en este celular.";
  todas.slice(0, 300).forEach((l) => {
    const p = buscar(normalizarCodigo(l.codigo));
    const fila = document.createElement("div");
    fila.className = "lectura" + (l.anul ? " anulada" : "");
    const que = document.createElement("div");
    que.className = "que";
    const prod = document.createElement("div");
    prod.className = "prod";
    prod.textContent = p ? `${p.descripcion}${p.talla ? " · T" + p.talla : ""}` : "No está en el Excel de SAP";
    const meta = document.createElement("div");
    meta.className = "meta";
    const estado = l.anul ? "anulada" : l.env ? "✓ enviada" : "⏳ por enviar";
    meta.textContent = `${l.hora.slice(11)} · ${l.codigo} · ${estado}`;
    que.append(prod, meta);
    fila.append(que);
    if (!l.anul) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Anular";
      b.addEventListener("click", () => {
        if (confirm(`¿Anular esta lectura?\n\n${l.hora.slice(11)} · ${l.codigo}\n${prod.textContent}`)) {
          anularLectura(l);
          pintarLecturas();
        }
      });
      fila.append(b);
    }
    lista.append(fila);
  });
}

// ---------------------------------------------------------------- acciones
async function empezar() {
  prepararAudio();
  equipo.nombre = $("inp-nombre").value.replace(/\s+/g, " ").trim().slice(0, 30);
  almacen.guardar("equipo", equipo);
  mostrarVista("pistoleo");
  if (!$("res-titulo").textContent) {
    mostrarResultado("info", "Listo para pistolear", "Apunta la cámara al código de barras, dentro del recuadro.");
  }
  mantenerPantalla();
  const ok = await abrirCamara("barras", "hueco-pistoleo");
  if (!ok) $("form-escribir").classList.remove("oculto");
}

async function vincular() {
  prepararAudio();
  $("hueco-vincular").classList.remove("oculto");
  $("btn-vincular").classList.add("oculto");
  await abrirCamara("qr", "hueco-vincular");
}

function vinculado(c) {
  const cambio = !config || config.h !== c.h || config.f !== c.f;
  cerrarCamara();
  if (cambio) {
    aplicarConfig(c);
  } else {
    config = c;  // la misma tienda: se conserva todo y se vuelve a intentar enviar
    almacen.guardar("config", c);
    if (red.estado === "enlace") red.estado = "inicio";
    programarEnvio(0);
  }
  sonido("ok");
  mostrarVista("inicio");
  if (cambio) mostrarResultado("info", "Listo para pistolear", "Tienda: " + (c.t || ""));
}

let instalador = null;
function pintarInstalar() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const instalada = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  $("btn-instalar").classList.toggle("oculto", !instalador || instalada);
  document.querySelector('[data-accion="instalar"]').classList.toggle("oculto", !instalador || instalada);
  $("ayuda-ios").classList.toggle("oculto", !ios || instalada);
}

async function instalar() {
  if (!instalador) return;
  instalador.prompt();
  try { await instalador.userChoice; } catch (e) { /* nada */ }
  instalador = null;
  pintarInstalar();
}

function accionMenu(accion) {
  $("capa-menu").classList.add("oculto");
  if (accion === "lecturas") {
    pintarLecturas();
    $("capa-lecturas").classList.remove("oculto");
  } else if (accion === "nombre") {
    const nombre = prompt("Nombre de quien pistolea con este celular:", equipo.nombre || "");
    if (nombre !== null) {
      equipo.nombre = nombre.replace(/\s+/g, " ").trim().slice(0, 30);
      almacen.guardar("equipo", equipo);
    }
  } else if (accion === "stock") {
    cargarStock(true);
  } else if (accion === "pausar") {
    mostrarVista("inicio");
  } else if (accion === "vincular") {
    mostrarVista("vincular");
  } else if (accion === "instalar") {
    instalar();
  }
}

// Una pistola Bluetooth conectada al celular escribe como un teclado y termina con Enter.
let teclas = "";
let ultimaTecla = 0;
function alTeclear(e) {
  if (vista !== "pistoleo" || e.target instanceof HTMLInputElement) return;
  const ahora = performance.now();
  if (ahora - ultimaTecla > 120) teclas = "";
  ultimaTecla = ahora;
  if (e.key === "Enter") {
    if (teclas.length >= 4) anotar(teclas);
    teclas = "";
  } else if (e.key.length === 1) {
    teclas += e.key;
  }
}

function iniciar() {
  const desdeEnlace = configDesdeTexto(location.href);
  if (desdeEnlace) {
    aplicarConfig(desdeEnlace);
    history.replaceState(null, "", location.pathname + location.search);  // el permiso no queda a la vista
  } else if (config) {
    cargarTienda();
  }

  $("btn-empezar").addEventListener("click", empezar);
  $("btn-vincular").addEventListener("click", vincular);
  $("btn-vincular-volver").addEventListener("click", () => mostrarVista("inicio"));
  $("btn-deshacer").addEventListener("click", deshacer);
  $("btn-escribir").addEventListener("click", () => {
    const f = $("form-escribir");
    f.classList.toggle("oculto");
    if (!f.classList.contains("oculto")) $("inp-codigo").focus();
  });
  $("form-escribir").addEventListener("submit", (e) => {
    e.preventDefault();
    prepararAudio();
    const valor = $("inp-codigo").value;
    $("inp-codigo").value = "";
    anotar(valor);
    $("inp-codigo").focus();
  });
  $("btn-linterna").addEventListener("click", alternarLinterna);
  $("btn-menu").addEventListener("click", () => $("capa-menu").classList.remove("oculto"));
  $("capa-menu").addEventListener("click", (e) => {
    const boton = e.target.closest("[data-accion]");
    if (boton) accionMenu(boton.dataset.accion);
    else if (e.target === $("capa-menu")) $("capa-menu").classList.add("oculto");
  });
  $("btn-cerrar-lecturas").addEventListener("click", () => $("capa-lecturas").classList.add("oculto"));
  $("capa-lecturas").addEventListener("click", (e) => {
    if (e.target === $("capa-lecturas")) $("capa-lecturas").classList.add("oculto");
  });
  $("estado-red").addEventListener("click", () => {
    if (red.estado === "enlace") {
      mostrarVista("vincular");
    } else if (red.error) {
      alert(red.error);
    }
    retraso = 2000;
    programarEnvio(0);
  });
  $("camara-msg").addEventListener("click", () => {
    if (!stream && modoCamara) abrirCamara(modoCamara, modoCamara === "qr" ? "hueco-vincular" : "hueco-pistoleo");
  });
  document.addEventListener("keydown", alTeclear);
  window.addEventListener("hashchange", () => {
    // se abrió el enlace de una tienda con la página ya abierta
    const c = configDesdeTexto(location.href);
    if (!c) return;
    history.replaceState(null, "", location.pathname + location.search);
    vinculado(c);
  });
  window.addEventListener("online", () => { retraso = 2000; programarEnvio(0); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      programarEnvio(0);
      if (vista === "pistoleo") {
        mantenerPantalla();
        if (!stream) abrirCamara("barras", "hueco-pistoleo");
      }
    } else if (stream && vista === "pistoleo") {
      cerrarCamara();  // al salir de la página se libera la cámara
    }
  });
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    instalador = e;
    pintarInstalar();
  });
  pintarInstalar();
  mostrarVista(config ? "inicio" : "vincular");

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* sin uso sin conexión */ });
  }
}

iniciar();
