import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY, APP_NOMBRE, INSTRUMENTOS, NOTAS_TABS, REACCIONES, ROLES, ROLES_CANTO, ICON_INSTR, VAPID_PUBLIC_KEY } from './config.js';
import {
  TONOS_MAYORES, TONOS_MENORES, TODOS_LOS_TONOS, parseTono, usaBemoles, distancia,
  transponerTono, renderLetra, primerAcorde, cifrado, esAcorde, acordesDelTono, aCorchetes,
} from './acordes.js';
import { generarCifrado, renderCifrado, erroresCifrado, AYUDA_CIFRADO } from './cifrado.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// =====================================================================
// Estado y utilidades
// =====================================================================
const st = {
  uid: null,
  perfil: null,
  perfiles: new Map(),   // id -> perfil (todos los visibles)
  vista: 0,              // token para descartar renders viejos
  limpiar: [],           // funciones a ejecutar al cambiar de vista
  muroLimite: 20,
  comAbiertos: new Set(),
  instalarEvt: null,
  tipos: [],            // tipos de día (agenda)
  faltaV2: false,       // true si falta ejecutar 002_agenda.sql
  faltaV4: false,       // true si falta ejecutar 004_voz_dirige_chat.sql
  faltaV6: false,       // true si falta ejecutar 006_ritmo.sql
  seguirVivo: true,     // seguir al líder en modo en vivo
  faltaV7: false,       // true si falta ejecutar 007_menciones_push.sql
  menNoLeidas: 0,       // menciones sin leer
  canalGlobal: null,    // canal de tiempo real de mis menciones
  historial: null,      // cancion_id -> { ultima_vez, veces_90d, veces_total }
  historialT: 0,
};

const LS = 'alabanza.ajustes';
const ajustes = (() => {
  const def = { latino: false, acordes: true, fuente: 18, vista: 'letra' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return def; }
})();
const guardarAjustes = () => { try { localStorage.setItem(LS, JSON.stringify(ajustes)); } catch {} };

// ---------- tema claro / oscuro ----------
const mqClaro = matchMedia('(prefers-color-scheme: light)');
function aplicarTema() {
  const t = ajustes.tema === 'claro' || ajustes.tema === 'oscuro' ? ajustes.tema : 'auto';
  if (t === 'auto') delete document.documentElement.dataset.tema;
  else document.documentElement.dataset.tema = t;
  const claro = t === 'claro' || (t === 'auto' && mqClaro.matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', claro ? '#f5f3ee' : '#11131c');
}
aplicarTema();
mqClaro.addEventListener?.('change', aplicarTema);

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esAdmin = () => st.perfil?.rol === 'admin';
const nombreDe = id => st.perfiles.get(id)?.nombre || 'Alguien';
const iniciales = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
const normalizar = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const tonoTxt = t => (t ? cifrado(t, ajustes.latino) : '—');
const aprobados = () => [...st.perfiles.values()].filter(p => p.estado === 'aprobado').sort((a, b) => a.nombre.localeCompare(b.nombre));
const cantantes = () => {
  return aprobados().sort((a, b) => ((b.instrumento === 'voz') - (a.instrumento === 'voz')) || a.nombre.localeCompare(b.nombre));
};

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), err ? 4500 : 2500);
}

function fallo(e, contexto = 'Error') {
  console.error(contexto, e);
  const m = e?.message || String(e);
  let txt = m;
  if (/row-level security|permission denied/i.test(m)) txt = 'No tienes permiso para hacer esto.';
  else if (/Failed to fetch|NetworkError|network/i.test(m)) txt = 'Sin conexión. Revisa tu internet.';
  else if (/duplicate key/i.test(m)) txt = 'Ese registro ya existe.';
  toast(`${contexto}: ${txt}`, true);
}

// ---------- sin conexión: copia local de lo consultado ----------
const idb = (() => {
  let dbp;
  const abrir = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('alabanza', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('datos');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (modo, fn) => {
    const db = await abrir();
    return new Promise((res, rej) => {
      const t = db.transaction('datos', modo);
      const req = fn(t.objectStore('datos'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {}),
    limpiar: () => tx('readwrite', s => s.clear()).catch(() => {}),
  };
})();

const esErrorRed = e => !navigator.onLine || /failed to fetch|networkerror|network request|load failed|fetch/i.test(e?.message || '');

function avisoOffline(on) {
  const b = $('#offline');
  if (b) b.hidden = !on;
}
window.addEventListener('offline', () => avisoOffline(true));
window.addEventListener('online', () => { avisoOffline(false); if (st.perfil?.estado === 'aprobado') rutear(); });

/** Ejecuta una consulta; si no hay internet devuelve la última copia guardada. */
async function conCache(clave, consulta) {
  const k = `${st.uid}:${clave}`;
  let r;
  try { r = await consulta; } catch (e) { r = { data: null, error: e }; }
  if (!r.error) { idb.set(k, r.data ?? null); return r; }
  if (esErrorRed(r.error)) {
    const v = await idb.get(k);
    if (v !== undefined) { avisoOffline(true); return { data: v, error: null, offline: true }; }
  }
  return r;
}

const hoy = new Date();
function haceCuanto(iso) {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 604800) return `hace ${Math.floor(s / 86400)} d`;
  return d.toLocaleDateString('es-PA', { day: 'numeric', month: 'short', year: d.getFullYear() !== hoy.getFullYear() ? 'numeric' : undefined });
}
const fmtFechaLarga = iso => new Date(iso).toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtHora = iso => new Date(iso).toLocaleTimeString('es-PA', { hour: 'numeric', minute: '2-digit' });
const aLocalInput = iso => { const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

function urlSegura(u) {
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}

function embedVideo(url) {
  const u = urlSegura(url);
  if (!u) return '';
  let m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/.exec(u);
  if (m) return `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${m[1]}" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy" title="Video"></iframe></div>`;
  m = /drive\.google\.com\/(?:file\/d\/|open\?id=)([\w-]+)/.exec(u);
  if (m) return `<div class="video"><iframe src="https://drive.google.com/file/d/${m[1]}/preview" allow="autoplay; fullscreen" allowfullscreen loading="lazy" title="Video"></iframe></div>`;
  return `<a class="btn sm link-video" href="${esc(u)}" target="_blank" rel="noopener">▶ Ver video</a>`;
}

const opcionesInstrumento = sel => Object.entries(INSTRUMENTOS)
  .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');

const opcionesTono = (sel, lista = TODOS_LOS_TONOS, vacio = 'Sin definir') =>
  `<option value="">${vacio}</option>` + lista.map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${esc(tonoTxt(t))}</option>`).join('');

// ---------- modal ----------
const dlg = $('#modal');
dlg.addEventListener('click', e => { if (e.target === dlg) cerrarModal(); });
function abrirModal(titulo, html, { visor = false } = {}) {
  const body = $('#modalBody');
  body.className = visor ? 'visor' : '';
  body.innerHTML = visor ? html : `<div class="modal-h"><h2>${esc(titulo)}</h2><button type="button" data-cerrar aria-label="Cerrar">×</button></div>${html}`;
  body.querySelectorAll('[data-cerrar]').forEach(b => (b.onclick = cerrarModal));
  if (!dlg.open) dlg.showModal();
  return body;
}
function cerrarModal() { if (dlg.open) dlg.close(); }

async function ocupado(btn, fn) {
  const txt = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  try { return await fn(); } finally { if (btn) { btn.disabled = false; btn.textContent = txt; } }
}

function encabezado(titulo, { sub = '', atras = null, derecha = '' } = {}) {
  const izq = atras
    ? `<button class="atras" data-atras="${esc(atras)}" aria-label="Volver">‹</button>`
    : `<img src="icons/logo.png" alt="">`;
  return `<header class="top">${izq}<h1>${esc(titulo)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</h1>${derecha}
    <button type="button" class="campana" data-men aria-label="Menciones">🔔<b class="men-badge"${st.menNoLeidas ? '' : ' hidden'}>${st.menNoLeidas > 9 ? '9+' : st.menNoLeidas}</b></button>
    <a class="avatar" href="#/perfil" title="Mi perfil">${esc(iniciales(st.perfil?.nombre))}</a></header>`;
}

// Navegación "atrás" genérica
app.addEventListener('click', e => {
  const b = e.target.closest('[data-atras]');
  if (b) { e.preventDefault(); location.hash = b.dataset.atras; }
});

// =====================================================================
// Sesión
// =====================================================================
const baseUrl = () => location.origin + location.pathname;

sb.auth.onAuthStateChange((evento, session) => {
  // No llamar a Supabase dentro del callback (puede bloquear): diferir.
  setTimeout(() => {
    if (evento === 'PASSWORD_RECOVERY') return modalNuevaClave();
    const uid = session?.user?.id || null;
    if (uid === st.uid && evento !== 'USER_UPDATED' && st.perfil) return;
    st.uid = uid;
    arrancar(session);
  }, 0);
});

async function arrancar(session) {
  st.limpiar.forEach(f => f()); st.limpiar = [];
  if (!session) {
    st.perfil = null;
    if (st.canalGlobal) { sb.removeChannel(st.canalGlobal); st.canalGlobal = null; }
    $('#nav').hidden = true;
    return vistaAuth();
  }
  let { data: perfil, error } = await conCache('perfil', sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
  if (!perfil && !error) {
    await new Promise(r => setTimeout(r, 1200));
    ({ data: perfil, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
  }
  if (error) { app.innerHTML = `<div class="auth"><div class="msg err">No se pudo cargar tu perfil: ${esc(error.message)}</div><button class="btn blk" onclick="location.reload()">Reintentar</button></div>`; return; }
  st.perfil = perfil;
  if (!perfil || perfil.estado !== 'aprobado') { $('#nav').hidden = true; return vistaPendiente(); }
  await Promise.all([cargarPerfiles(), cargarTipos()]);
  iniciarGlobal();
  $('#nav').hidden = false;
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.replace('#/muro');
  else rutear();
}

async function cargarPerfiles() {
  const { data, error } = await conCache('perfiles', sb.from('profiles').select('*').order('nombre'));
  if (error) return fallo(error, 'Perfiles');
  st.perfiles = new Map(data.map(p => [p.id, p]));
  if (st.perfiles.has(st.uid)) st.perfil = st.perfiles.get(st.uid);
  const pend = data.filter(p => p.estado === 'pendiente').length;
  const b = $('#badgePend');
  b.hidden = !(esAdmin() && pend);
  b.textContent = pend;
}

// =====================================================================
// Login / registro
// =====================================================================
function vistaAuth(modo = 'login', aviso = null) {
  const titulos = { login: 'Entrar', registro: 'Crear cuenta', olvido: 'Recuperar contraseña' };
  app.innerHTML = `
  <div class="auth">
    <img class="logo" src="icons/logo.png" alt="Roca de Vida Panamá">
    <h1>${esc(APP_NOMBRE)}</h1>
    <p class="lema">Equipo de alabanza</p>
    ${modo !== 'olvido' ? `<div class="tabs-auth">
      <button type="button" data-modo="login" class="${modo === 'login' ? 'activo' : ''}">Entrar</button>
      <button type="button" data-modo="registro" class="${modo === 'registro' ? 'activo' : ''}">Crear cuenta</button>
    </div>` : `<h2 style="margin:0 0 4px;font-size:18px">${titulos.olvido}</h2>`}
    <form id="fAuth" autocomplete="on">
      ${modo === 'registro' ? `
        <label>Nombre</label><input name="nombre" required maxlength="60" autocomplete="name" placeholder="Cómo te conoce el equipo">
        <label>¿Qué haces en el equipo?</label><select name="instrumento" required><option value="">Elige…</option>${opcionesInstrumento('')}</select>` : ''}
      <label>Correo</label><input name="email" type="email" required autocomplete="email" inputmode="email">
      ${modo !== 'olvido' ? `<label>Contraseña</label><input name="clave" type="password" required minlength="6" autocomplete="${modo === 'login' ? 'current-password' : 'new-password'}">` : ''}
      <button class="btn prim blk" type="submit">${titulos[modo]}</button>
    </form>
    <div id="authMsg">${aviso ? `<div class="msg ${aviso.err ? 'err' : 'ok'}">${esc(aviso.txt)}</div>` : ''}</div>
    ${modo === 'login' ? `<button class="link" data-modo="olvido">¿Olvidaste tu contraseña?</button>` : ''}
    ${modo === 'olvido' ? `<button class="link" data-modo="login">‹ Volver a entrar</button>` : ''}
  </div>`;
  app.onclick = e => { const b = e.target.closest('[data-modo]'); if (b) vistaAuth(b.dataset.modo); };
  $('#fAuth').onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    const msg = (txt, err = true) => ($('#authMsg').innerHTML = `<div class="msg ${err ? 'err' : 'ok'}">${esc(txt)}</div>`);
    btn.disabled = true;
    try {
      if (modo === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.clave });
        if (error) msg(/invalid login/i.test(error.message) ? 'Correo o contraseña incorrectos.'
          : /not confirmed/i.test(error.message) ? 'Primero confirma tu correo (revisa tu bandeja y spam).' : error.message);
      } else if (modo === 'registro') {
        const { data, error } = await sb.auth.signUp({
          email: f.email.trim(), password: f.clave,
          options: { data: { nombre: f.nombre.trim(), instrumento: f.instrumento }, emailRedirectTo: baseUrl() },
        });
        if (error) msg(/already registered/i.test(error.message) ? 'Ese correo ya tiene cuenta. Usa "Entrar".'
          : /rate limit/i.test(error.message) ? 'Hay muchos registros seguidos. Espera unos minutos e inténtalo de nuevo.' : error.message);
        else if (!data.session) vistaAuth('login', { txt: 'Te enviamos un correo para confirmar tu cuenta. Después entra aquí; un administrador debe aprobarte.' });
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(f.email.trim(), { redirectTo: baseUrl() });
        if (error) msg(/rate limit/i.test(error.message) ? 'Se enviaron muchos correos seguidos. Espera unos minutos e inténtalo de nuevo.' : error.message); else msg('Si el correo está registrado, te llegará un enlace para cambiar la contraseña.', false);
      }
    } catch (err) { msg(err.message || 'Error de conexión'); }
    finally { btn.disabled = false; }
  };
}

function vistaPendiente() {
  const bloqueado = st.perfil?.estado === 'bloqueado';
  app.innerHTML = `
  <div class="auth" style="text-align:center">
    <img class="logo" src="icons/logo.png" alt="">
    <h1>${bloqueado ? 'Acceso desactivado' : '¡Ya casi!'}</h1>
    <p class="lema">${bloqueado
      ? 'Tu cuenta fue desactivada. Habla con un administrador del equipo.'
      : `Hola ${esc(st.perfil?.nombre || '')}, tu cuenta está <b>pendiente de aprobación</b>. Avísale a un administrador del equipo para que te apruebe.`}</p>
    <button class="btn prim blk" id="bRev">Ya me aprobaron</button>
    <button class="btn blk" id="bSalir">Cerrar sesión</button>
  </div>`;
  app.onclick = null;
  $('#bRev').onclick = () => sb.auth.getSession().then(({ data }) => arrancar(data.session));
  $('#bSalir').onclick = () => sb.auth.signOut();
}

function modalNuevaClave() {
  const body = abrirModal('Nueva contraseña', `
    <form id="fClave"><label>Nueva contraseña</label><input name="clave" type="password" minlength="6" required autocomplete="new-password">
    <button class="btn prim blk">Guardar</button></form>`);
  $('#fClave', body).onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get('clave') });
    if (error) return fallo(error, 'Contraseña');
    cerrarModal(); toast('Contraseña actualizada');
  };
}

// =====================================================================
// Router
// =====================================================================
const RUTAS = {
  muro: vistaMuro,
  canciones: vistaCanciones,
  cancion: vistaCancion,
  agenda: vistaAgenda,
  ensayos: vistaAgenda,
  dia: vistaDia,
  ensayo: vistaDia,
  plan: vistaPlan,
  equipo: vistaEquipo,
  perfil: vistaPerfil,
};
const TAB_DE = { cancion: 'canciones', ensayos: 'agenda', ensayo: 'agenda', dia: 'agenda', plan: 'agenda', perfil: 'equipo' };

window.addEventListener('hashchange', () => st.perfil?.estado === 'aprobado' && rutear());

function rutear() {
  const [ruta, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [nombre, id] = ruta.split('/');
  const fn = RUTAS[nombre] || vistaMuro;
  st.limpiar.forEach(f => f()); st.limpiar = [];
  const token = ++st.vista;
  const tab = TAB_DE[nombre] || (RUTAS[nombre] ? nombre : 'muro');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('activo', a.dataset.tab === tab));
  app.onclick = null; app.oninput = null; app.onchange = null;
  window.scrollTo(0, 0);
  fn({ id, q: new URLSearchParams(qs), vigente: () => token === st.vista });
}

function cargando(titulo, opts) {
  app.innerHTML = encabezado(titulo, opts) + '<div class="spinner"></div>';
}

// =====================================================================
// MURO
// =====================================================================
async function vistaMuro(ctx) {
  cargando('Muro', { sub: 'Roca de Vida Panamá' });
  const render = async () => {
    const SEL_PROG = ', setlist:setlists(id, titulo, fecha, ensayo_fecha, lugar, tipo, tipo_evento_id, asignaciones(perfil_id, rol, estado), setlist_items(orden, tono, cantante_id' + (st.faltaV6 ? '' : ', ritmo') + ', cancion:canciones(titulo, tono_original' + (st.faltaV6 ? '' : ', ritmo') + ')))';
    const [{ data, error }, pend, rv] = await Promise.all([
      conCache('muro', sb.from('publicaciones')
        .select('*, comentarios(id, contenido, created_at, autor_id), reacciones(emoji, usuario_id)' + (st.faltaV2 ? '' : SEL_PROG))
        .order('fijada', { ascending: false }).order('created_at', { ascending: false })
        .range(0, st.muroLimite - 1)),
      misPendientes(),
      st.faltaV2 ? Promise.resolve({ data: [] }) : sb.from('en_vivo').select('indice, setlist:setlists(id, titulo, tipo, tipo_evento_id)').eq('activo', true),
    ]);
    if (!ctx.vigente()) return;
    if (error) return fallo(error, 'Muro');
    const posts = data.map(tarjetaPost).join('');
    const enVivo = (rv.data || []).filter(v => v.setlist).map(v => `
      <a class="card vivo-banner" href="#/dia/${v.setlist.id}"><span class="punto-vivo"></span>
        <div class="info"><b>En vivo ahora</b><small>${esc(tipoDe(v.setlist).emoji)} ${esc(v.setlist.titulo)} · toca para unirte</small></div><span>›</span></a>`).join('');
    app.innerHTML = encabezado('Muro', { sub: 'Roca de Vida Panamá' }) + enVivo + tarjetaPorConfirmar(pend) + (posts || `
      <div class="vacio"><span class="grande">📣</span>Todavía no hay publicaciones.${esAdmin() ? '<br>Toca <b>+</b> para crear la primera.' : ''}</div>`)
      + (data.length >= st.muroLimite ? `<button class="btn blk" data-acc="mas">Ver más</button>` : '')
      + (esAdmin() ? `<button class="fab" data-acc="nuevo" aria-label="Nueva publicación">+</button>` : '');
    app._posts = new Map(data.map(p => [p.id, p]));
  };
  await render();

  // Tiempo real
  let t;
  const recargar = () => { clearTimeout(t); t = setTimeout(() => ctx.vigente() && !app.querySelector('.nuevo-com input:focus') && render(), 500); };
  const canal = sb.channel('muro')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'publicaciones' }, recargar)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'en_vivo' }, recargar)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comentarios' }, recargar)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reacciones' }, recargar)
    .subscribe();
  st.limpiar.push(() => { clearTimeout(t); sb.removeChannel(canal); });

  app.onclick = async e => {
    const el = e.target.closest('[data-acc]');
    if (!el) {
      const img = e.target.closest('.post-img');
      if (img) abrirModal('', `<img src="${esc(img.src)}" alt="">`, { visor: true });
      return;
    }
    const { acc, id } = el.dataset;
    const post = app._posts?.get(id);
    try {
      if (acc === 'mas') { st.muroLimite += 20; await render(); }
      else if (acc === 'nuevo') modalPost(null, render);
      else if (acc === 'editar') modalPost(post, render);
      else if (acc === 'fijar') {
        const { error } = await sb.from('publicaciones').update({ fijada: !post.fijada }).eq('id', id);
        if (error) throw error; await render();
      } else if (acc === 'borrar') {
        if (!confirm('¿Eliminar esta publicación?')) return;
        const { error } = await sb.from('publicaciones').delete().eq('id', id);
        if (error) throw error;
        const ruta = rutaMedia(post.media_url);
        if (ruta) sb.storage.from('media').remove([ruta]);
        await render(); toast('Publicación eliminada');
      } else if (acc === 'reac') {
        const { emoji } = el.dataset;
        const mia = post.reacciones.some(r => r.emoji === emoji && r.usuario_id === st.uid);
        const q = mia
          ? sb.from('reacciones').delete().match({ publicacion_id: id, usuario_id: st.uid, emoji })
          : sb.from('reacciones').insert({ publicacion_id: id, usuario_id: st.uid, emoji });
        const { error } = await q; if (error) throw error; await render();
      } else if (acc === 'coms') {
        st.comAbiertos.has(id) ? st.comAbiertos.delete(id) : st.comAbiertos.add(id);
        await render();
        if (st.comAbiertos.has(id)) app.querySelector(`[data-com-form="${id}"] input`)?.focus();
      } else if (acc === 'conf') {
        await responderAsignacion(id, el.dataset.estado);
      } else if (acc === 'borrar-com') {
        if (!confirm('¿Eliminar comentario?')) return;
        const { error } = await sb.from('comentarios').delete().eq('id', el.dataset.com);
        if (error) throw error; await render();
      }
    } catch (err) { fallo(err, 'Muro'); }
  };

  app.onsubmit = async e => {
    const id = e.target.dataset.comForm;
    if (!id) return;
    e.preventDefault();
    const inp = e.target.querySelector('input');
    const contenido = inp.value.trim();
    if (!contenido) return;
    inp.disabled = true;
    const { error } = await sb.from('comentarios').insert({ publicacion_id: id, autor_id: st.uid, contenido });
    inp.disabled = false;
    if (error) return fallo(error, 'Comentario');
    inp.value = '';
    await render();
  };
  st.limpiar.push(() => (app.onsubmit = null));
}

function tarjetaPost(p) {
  const autor = st.perfiles.get(p.autor_id);
  const coms = [...(p.comentarios || [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const conteo = {};
  (p.reacciones || []).forEach(r => {
    conteo[r.emoji] ??= { n: 0, mia: false };
    conteo[r.emoji].n++;
    if (r.usuario_id === st.uid) conteo[r.emoji].mia = true;
  });
  const abiertos = st.comAbiertos.has(p.id);
  const etiquetas = [
    p.fijada ? '<span class="tag fijada">📌 Fijada</span>' : '',
    p.tipo === 'comunicado' ? '<span class="tag comunicado">Comunicado</span>' : '',
    p.tipo === 'programa' ? '<span class="tag comunicado">Programa</span>' : '',
  ].join(' ');
  const cuerpo = p.tipo === 'programa'
    ? `${p.setlist ? `<h3 class="post-titulo">${esc(tipoDe(p.setlist).emoji)} ${esc(p.setlist.titulo)}</h3>` : `<h3 class="post-titulo">${esc(p.titulo)}</h3>`}
       ${p.contenido ? `<p class="post-texto">${esc(p.contenido)}</p>` : ''}
       ${p.setlist ? resumenDia(p.setlist, p.setlist.setlist_items) + `<a class="btn sm" href="#/dia/${p.setlist.id}" style="margin-top:10px">Ver día completo ›</a>` : '<p class="ayuda">Este día ya no existe.</p>'}`
    : p.tipo === 'frase'
    ? `<p class="post-frase">${esc(p.contenido)}</p>`
    : `${p.titulo ? `<h3 class="post-titulo">${esc(p.titulo)}</h3>` : ''}${p.contenido ? `<p class="post-texto">${esc(p.contenido)}</p>` : ''}`;
  const img = urlSegura(p.media_url) ? `<img class="post-img" src="${esc(p.media_url)}" alt="" loading="lazy">` : '';
  return `
  <article class="card ${p.fijada ? 'fijada' : ''} ${p.tipo === 'comunicado' || p.tipo === 'programa' ? 'comunicado' : ''}">
    <div class="post-head">
      <span class="avatar sm">${esc(iniciales(autor?.nombre))}</span>
      <div class="quien"><b>${esc(autor?.nombre || 'Administración')}</b><small>${haceCuanto(p.created_at)}</small> ${etiquetas}</div>
    </div>
    ${p.tipo === 'frase' && p.titulo ? `<h3 class="post-titulo">${esc(p.titulo)}</h3>` : ''}
    ${cuerpo}${img}${p.video_url ? embedVideo(p.video_url) : ''}
    <div class="reacciones">
      ${REACCIONES.map(em => {
        const c = conteo[em];
        return `<button class="reac ${c?.mia ? 'mia' : ''}" data-acc="reac" data-id="${p.id}" data-emoji="${em}">${em}${c ? `<small>${c.n}</small>` : ''}</button>`;
      }).join('')}
    </div>
    <div class="acciones">
      <button data-acc="coms" data-id="${p.id}">💬 ${coms.length ? `${coms.length} comentario${coms.length > 1 ? 's' : ''}` : 'Comentar'}</button>
      ${esAdmin() ? `
        <button data-acc="fijar" data-id="${p.id}">${p.fijada ? 'Desfijar' : '📌 Fijar'}</button>
        ${p.tipo === 'programa' ? '' : `<button data-acc="editar" data-id="${p.id}">✏️</button>`}
        <button data-acc="borrar" data-id="${p.id}">🗑️</button>` : ''}
    </div>
    ${abiertos ? `<div class="comentarios">
      ${coms.map(c => `
        <div class="comentario">
          <span class="avatar sm">${esc(iniciales(nombreDe(c.autor_id)))}</span>
          <div class="burbuja"><b>${esc(nombreDe(c.autor_id))}</b> <small>${haceCuanto(c.created_at)}</small><p>${esc(c.contenido)}</p></div>
          ${c.autor_id === st.uid || esAdmin() ? `<button class="x" data-acc="borrar-com" data-com="${c.id}" aria-label="Eliminar">✕</button>` : ''}
        </div>`).join('')}
      <form class="nuevo-com" data-com-form="${p.id}">
        <input placeholder="Escribe un comentario…" maxlength="1000" enterkeyhint="send">
        <button class="btn sm prim">Enviar</button>
      </form>
    </div>` : ''}
  </article>`;
}

function rutaMedia(url) {
  const m = /\/storage\/v1\/object\/public\/media\/(.+)$/.exec(url || '');
  return m ? decodeURIComponent(m[1]) : null;
}

async function comprimirImagen(file, max = 1600, calidad = 0.85) {
  if (file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const r = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * r); c.height = Math.round(bmp.height * r);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', calidad));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; }
}

function modalPost(post, alGuardar) {
  const p = post || { tipo: 'comunicado', fijada: false };
  const body = abrirModal(post ? 'Editar publicación' : 'Nueva publicación', `
    <form id="fPost">
      <div class="segmentado" id="segTipo">
        ${[['comunicado', '📢 Comunicado'], ['frase', '✨ Frase'], ['imagen', '🖼️ Imagen'], ['video', '🎬 Video']]
          .map(([k, v]) => `<button type="button" data-tipo="${k}" class="${p.tipo === k ? 'activo' : ''}">${v}</button>`).join('')}
      </div>
      <input type="hidden" name="tipo" value="${esc(p.tipo)}">
      <label>Título <span style="font-weight:400">(opcional)</span></label>
      <input name="titulo" maxlength="120" value="${esc(p.titulo)}">
      <label id="lblCont">Texto</label>
      <textarea name="contenido" maxlength="4000">${esc(p.contenido)}</textarea>
      <div id="campoImg">
        <label>Imagen</label>
        <input type="file" name="imagen" accept="image/*">
        ${p.media_url ? `<p class="ayuda">Ya tiene una imagen. Elige otra para reemplazarla. <label class="check" style="margin:6px 0 0"><input type="checkbox" name="quitarImg"> Quitar imagen</label></p>` : ''}
      </div>
      <div id="campoVideo">
        <label>Link del video (YouTube o Google Drive)</label>
        <input name="video_url" type="url" inputmode="url" placeholder="https://youtu.be/…" value="${esc(p.video_url)}">
        <p class="ayuda">En Drive, el archivo debe estar compartido como "Cualquier persona con el enlace".</p>
      </div>
      <label class="check"><input type="checkbox" name="fijada" ${p.fijada ? 'checked' : ''}> 📌 Fijar arriba del muro</label>
      <button class="btn prim blk" type="submit">${post ? 'Guardar cambios' : 'Publicar'}</button>
    </form>`);
  const form = $('#fPost', body);
  const ajustarTipo = tipo => {
    form.tipo.value = tipo;
    body.querySelectorAll('[data-tipo]').forEach(b => b.classList.toggle('activo', b.dataset.tipo === tipo));
    $('#lblCont', body).textContent = tipo === 'frase' ? 'Frase / versículo' : tipo === 'comunicado' ? 'Comunicado' : 'Descripción (opcional)';
  };
  ajustarTipo(p.tipo);
  $('#segTipo', body).onclick = e => { const b = e.target.closest('[data-tipo]'); if (b) ajustarTipo(b.dataset.tipo); };

  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = new FormData(form);
      const archivo = f.get('imagen');
      const datos = {
        tipo: f.get('tipo'),
        titulo: f.get('titulo').trim() || null,
        contenido: f.get('contenido').trim() || null,
        video_url: f.get('video_url').trim() || null,
        fijada: !!f.get('fijada'),
      };
      if (datos.video_url && !urlSegura(datos.video_url)) return toast('El link del video no es válido', true);
      if (!datos.contenido && !datos.titulo && !(archivo && archivo.size) && !datos.video_url && !p.media_url)
        return toast('La publicación está vacía', true);
      try {
        const anterior = p.media_url;
        if (archivo && archivo.size) {
          const blob = await comprimirImagen(archivo);
          const ext = blob.type === 'image/gif' ? 'gif' : blob.type === 'image/png' ? 'png' : 'jpg';
          const ruta = `${st.uid}/${Date.now()}.${ext}`;
          const { error: eUp } = await sb.storage.from('media').upload(ruta, blob, { contentType: blob.type || 'image/jpeg' });
          if (eUp) throw eUp;
          datos.media_url = sb.storage.from('media').getPublicUrl(ruta).data.publicUrl;
        } else if (f.get('quitarImg')) datos.media_url = null;
        const { error } = post
          ? await sb.from('publicaciones').update(datos).eq('id', post.id)
          : await sb.from('publicaciones').insert({ ...datos, autor_id: st.uid });
        if (error) throw error;
        if (post && anterior && datos.media_url !== undefined && datos.media_url !== anterior) {
          const r = rutaMedia(anterior); if (r) sb.storage.from('media').remove([r]);
        }
        cerrarModal(); toast(post ? 'Publicación actualizada' : 'Publicado');
        alGuardar();
      } catch (err) { fallo(err, 'Publicación'); }
    });
  };
}

// =====================================================================
// CANCIONES
// =====================================================================
async function vistaCanciones(ctx) {
  cargando('Canciones');
  const [{ data, error }, rpart] = await Promise.all([
    conCache('canciones', sb.from('canciones').select(st.faltaV6 ? 'id, titulo, artista, tono_original' : 'id, titulo, artista, tono_original, ritmo').order('titulo')),
    conCache('partituras-idx', sb.from('partituras').select('cancion_id, instrumento')),
  ]);
  if (!ctx.vigente()) return;
  if (error) return fallo(error, 'Canciones');
  const filtro = ctx.q.get('b') || '';
  const partes = {};   // cancion_id -> Set(instrumentos con partitura)
  (rpart.data || []).forEach(p => (partes[p.cancion_id] ??= new Set()).add(p.instrumento));
  let soloPart = false, filtroRitmo = '', soloOlv = false, hist = st.historial || new Map();
  const usadaHace = (id, n) => { const d = haceDias(hist.get(id)?.ultima_vez); return d != null && d < n; };
  app.innerHTML = encabezado('Canciones', { sub: `${data.length} en el repertorio` }) + `
    <div class="buscador"><input id="busca" type="search" placeholder="Buscar por título o artista" value="${esc(filtro)}"></div>
    <div class="segmentado" id="segPart"><button data-p="0" class="activo">Todas</button>${st.faltaV6 ? '' : '<button data-p="rapida">⚡ Rápidas</button><button data-p="lenta">🕊️ Lentas</button>'}<button data-p="olv">💤 Sin usar</button><button data-p="1">📄 Partitura</button></div>
    <div class="lista" id="lista"></div>
    ${esAdmin() ? `<button class="fab" data-acc="nueva" aria-label="Nueva canción">+</button>` : ''}`;
  const pintar = () => {
    const q = normalizar($('#busca').value);
    const res = data.filter(c => (!q || normalizar(c.titulo + ' ' + (c.artista || '')).includes(q)) && (!soloPart || partes[c.id]) && (!filtroRitmo || c.ritmo === filtroRitmo) && (!soloOlv || !usadaHace(c.id, 90)));
    if (soloOlv) res.sort((a, b) => (hist.get(a.id)?.ultima_vez || '').localeCompare(hist.get(b.id)?.ultima_vez || ''));
    $('#lista').innerHTML = res.map(c => `
      <a class="item" href="#/cancion/${c.id}">
        <div class="info"><b>${ICON_RITMO[c.ritmo] ? `<span title="${esc(RITMOS[c.ritmo])}">${ICON_RITMO[c.ritmo]}</span> ` : ''}${esc(c.titulo)}</b><small>${esc(c.artista || 'Sin artista')}${partes[c.id] ? ' · 📄 ' + [...partes[c.id]].map(i => ICON_INSTR[i] || '📄').join('') : ''}${hist.size ? ` · <span class="uso ${frescura(hist.get(c.id))}">🕒 ${esc(txtUltima(hist.get(c.id)?.ultima_vez))}</span>` : ''}</small></div>
        <span class="tono-pill">${esc(tonoTxt(c.tono_original))}</span>
      </a>`).join('') || `<div class="vacio"><span class="grande">🎵</span>${data.length ? 'Sin resultados.' : 'Aún no hay canciones.'}${!data.length && esAdmin() ? '<br>Toca <b>+</b> para agregar la primera.' : ''}</div>`;
  };
  pintar();
  cargarHistorial().then(h => { hist = h; if (ctx.vigente() && $('#lista')) pintar(); });
  app.oninput = e => { if (e.target.id === 'busca') { pintar(); history.replaceState(null, '', '#/canciones' + (e.target.value ? '?b=' + encodeURIComponent(e.target.value) : '')); } };
  app.onclick = e => {
    if (e.target.closest('[data-acc=nueva]')) return modalCancion(null);
    const b = e.target.closest('[data-p]');
    if (b) { soloPart = b.dataset.p === '1'; soloOlv = b.dataset.p === 'olv'; filtroRitmo = RITMOS[b.dataset.p] ? b.dataset.p : ''; $('#segPart').querySelectorAll('button').forEach(x => x.classList.toggle('activo', x === b)); pintar(); }
  };
}

function modalCancion(c) {
  const x = c || {};
  const body = abrirModal(c ? 'Editar canción' : 'Nueva canción', `
    <form id="fCan">
      <label>Título</label><input name="titulo" required maxlength="150" value="${esc(x.titulo)}">
      <label>Artista / autor</label><input name="artista" maxlength="120" value="${esc(x.artista)}">
      <div class="fila">
        <div><label>Tono original</label><select name="tono_original">${opcionesTono(x.tono_original)}</select></div>
        <div><label>BPM</label><input name="bpm" type="number" min="30" max="260" inputmode="numeric" value="${esc(x.bpm)}"></div>
        <div><label>Compás</label><input name="compas" maxlength="10" placeholder="4/4" value="${esc(x.compas)}"></div>
      </div>
      ${st.faltaV6 ? '' : `<label>Ritmo</label><select name="ritmo"><option value="">Sin definir</option>${Object.entries(RITMOS).map(([k, v]) =>
        `<option value="${k}" ${x.ritmo === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`}
      <label>Letra con acordes</label>
      <div class="segmentado" id="eaModos">
        <button type="button" data-modo="texto" class="activo">✏️ Escribir</button>
        <button type="button" data-modo="tocar">👆 Tocar acordes</button>
      </div>
      <div class="ea-teclas" id="eaTeclas"></div>
      <textarea class="letra" name="letra" spellcheck="false" placeholder="Escribe o pega la letra aquí.

Coro:
Cuan grande es Él…">${esc(x.letra)}</textarea>
      <div class="ea-tocar letra" id="eaTocar" hidden></div>
      <p class="ayuda" id="eaAyuda"></p>
      <label>Video de referencia (YouTube)</label>
      <input name="video_url" type="url" inputmode="url" value="${esc(x.video_url)}" placeholder="https://youtu.be/…">
      <button class="btn prim blk" type="submit">${c ? 'Guardar cambios' : 'Crear canción'}</button>
    </form>`);
  const form = $('#fCan', body);
  const ta = form.letra;
  const zona = $('#eaTocar', body);
  let modo = 'texto';
  let sel = null;            // { pos } | { ini, fin } (acorde seleccionado)
  let cursor = ta.value.length;
  ['click', 'keyup', 'input', 'select'].forEach(ev => ta.addEventListener(ev, () => (cursor = ta.selectionStart)));

  const tonoBase = () => form.tono_original.value || primerAcorde(ta.value) || 'G';
  const ayuda = () => {
    $('#eaAyuda', body).innerHTML = modo === 'texto'
      ? 'Pon el cursor donde va el acorde y toca un botón de arriba. También puedes pegar canciones con los acordes en la línea de arriba. Una línea que termina en <b>:</b> (ej. <b>Coro:</b>) se muestra como sección.'
      : sel?.ini !== undefined ? 'Acorde seleccionado: toca otro botón para cambiarlo o 🗑 para quitarlo.'
      : sel ? 'Ahora toca el acorde. Usa ‹ › para moverlo dentro de la palabra.'
      : 'Toca la palabra donde cambia el acorde y luego el acorde.';
  };

  const pintarTeclas = () => {
    const t = tonoBase();
    const { diatonicos, extras } = acordesDelTono(t);
    const btn = (ch, cls = '') => `<button type="button" class="ea-k ${cls}" data-ch="${esc(ch)}">${esc(cifrado(ch, ajustes.latino))}</button>`;
    $('#eaTeclas', body).innerHTML = `
      <div class="ea-fila"><small>Tono ${esc(tonoTxt(t))}</small>${diatonicos.map(ch => btn(ch)).join('')}</div>
      <div class="ea-fila">${extras.map(ch => btn(ch, 'sec')).join('')}
        <button type="button" class="ea-k sec" data-otro>Otro…</button>
        ${modo === 'tocar' && sel?.ini !== undefined ? '<button type="button" class="ea-k peligro" data-quitar>🗑 Quitar</button>' : ''}
        ${modo === 'tocar' && sel?.pos !== undefined ? '<button type="button" class="ea-k sec" data-mover="-1">‹</button><button type="button" class="ea-k sec" data-mover="1">›</button>' : ''}
      </div>`;
  };

  // ---- Modo tocar: la letra se muestra con palabras y acordes tocables ----
  const pintarZona = () => {
    const txt = ta.value;
    let html = '', base = 0;
    for (const linea of txt.split('\n')) {
      if (!linea.trim()) { html += '<div class="l-vacia"></div>'; base += linea.length + 1; continue; }
      let fila = '';
      const re = /\[[^\]]*\]|[^\s[]+|\s+/g; let m;
      while ((m = re.exec(linea))) {
        const ini = base + m.index, fin = ini + m[0].length, tok = m[0];
        if (tok[0] === '[') {
          const marcado = sel?.ini === ini ? ' sel' : '';
          fila += `<button type="button" class="ea-ch${marcado}" data-ini="${ini}" data-fin="${fin}">${esc(cifrado(tok.slice(1, -1), ajustes.latino))}</button>`;
        } else if (/^\s+$/.test(tok)) {
          fila += tok.replace(/ /g, '&nbsp;');
        } else if (sel?.pos !== undefined && sel.pos >= ini && sel.pos < fin) {
          const k = sel.pos - ini;
          fila += `<span class="ea-w sel" data-pos="${ini}">${esc(tok.slice(0, k))}<i class="caret"></i>${esc(tok.slice(k))}</span>`;
        } else {
          fila += `<span class="ea-w" data-pos="${ini}">${esc(tok)}</span>`;
        }
      }
      const finLinea = base + linea.length;
      fila += `<span class="ea-w ea-fin ${sel?.pos === finLinea ? 'sel' : ''}" data-pos="${finLinea}" title="Final de la línea">${sel?.pos === finLinea ? '<i class="caret"></i>' : ''}·</span>`;
      html += `<div class="ea-l">${fila}</div>`;
      base += linea.length + 1;
    }
    zona.innerHTML = html || '<p class="ayuda">Primero escribe o pega la letra en "Escribir".</p>';
  };

  const refrescar = () => { pintarTeclas(); if (modo === 'tocar') pintarZona(); ayuda(); };

  const insertar = ch => {
    const v = ta.value;
    if (modo === 'texto') {
      const p = Math.min(cursor, v.length);
      ta.value = v.slice(0, p) + `[${ch}]` + v.slice(p);
      cursor = p + ch.length + 2;
      if (!matchMedia('(pointer: coarse)').matches) { ta.focus(); ta.setSelectionRange(cursor, cursor); }
      return;
    }
    if (!sel) return toast('Primero toca la palabra donde va el acorde');
    if (sel.ini !== undefined) ta.value = v.slice(0, sel.ini) + `[${ch}]` + v.slice(sel.fin);
    else ta.value = v.slice(0, sel.pos) + `[${ch}]` + v.slice(sel.pos);
    sel = null;
    refrescar();
  };

  $('#eaModos', body).onclick = e => {
    const b = e.target.closest('[data-modo]');
    if (!b) return;
    modo = b.dataset.modo; sel = null;
    body.querySelectorAll('[data-modo]').forEach(x => x.classList.toggle('activo', x === b));
    if (modo === 'tocar') {
      const conv = aCorchetes(ta.value);
      if (conv !== ta.value) { ta.value = conv; toast('Acomodé los acordes de la línea de arriba dentro de la letra'); }
    }
    ta.hidden = modo === 'tocar';
    zona.hidden = modo !== 'tocar';
    refrescar();
  };
  $('#eaTeclas', body).onmousedown = e => e.preventDefault();   // no quitar el foco del texto
  $('#eaTeclas', body).onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.ch) insertar(b.dataset.ch);
    else if (b.hasAttribute('data-otro')) {
      const ch = (prompt('Escribe el acorde (ej: C#m7, G/B, Dsus4):') || '').trim();
      if (!ch) return;
      if (!esAcorde(ch)) return toast('Ese acorde no lo reconozco', true);
      insertar(ch);
    } else if (b.hasAttribute('data-quitar') && sel?.ini !== undefined) {
      ta.value = ta.value.slice(0, sel.ini) + ta.value.slice(sel.fin);
      sel = null; refrescar();
    } else if (b.dataset.mover && sel?.pos !== undefined) {
      const v = ta.value, paso = +b.dataset.mover;
      let nuevo = sel.pos + paso;
      // saltar por encima de un acorde completo
      if (paso > 0 && v[sel.pos] === '[') nuevo = v.indexOf(']', sel.pos) + 1;
      if (paso < 0 && v[nuevo] === ']') nuevo = v.lastIndexOf('[', nuevo);
      const cruzaLinea = v[paso > 0 ? sel.pos : nuevo] === '\n';
      if (nuevo >= 0 && nuevo <= v.length && !cruzaLinea) sel = { pos: nuevo };
      refrescar();
    }
  };
  zona.onclick = e => {
    const ch = e.target.closest('.ea-ch');
    const w = e.target.closest('.ea-w');
    if (ch) sel = sel?.ini === +ch.dataset.ini ? null : { ini: +ch.dataset.ini, fin: +ch.dataset.fin };
    else if (w) sel = sel?.pos === +w.dataset.pos ? null : { pos: +w.dataset.pos };
    else return;
    refrescar();
  };
  form.tono_original.onchange = pintarTeclas;
  refrescar();

  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = Object.fromEntries(new FormData(form));
      const datos = {
        titulo: f.titulo.trim(),
        artista: f.artista.trim() || null,
        tono_original: f.tono_original || primerAcorde(f.letra) || null,
        bpm: f.bpm ? parseInt(f.bpm, 10) : null,
        compas: f.compas.trim() || null,
        letra: f.letra,
        video_url: urlSegura(f.video_url.trim()) || null,
        ...(st.faltaV6 ? {} : { ritmo: f.ritmo || null }),
      };
      if (datos.tono_original && !parseTono(datos.tono_original)) datos.tono_original = null;
      const q = c
        ? sb.from('canciones').update(datos).eq('id', c.id).select('id').single()
        : sb.from('canciones').insert({ ...datos, creado_por: st.uid }).select('id').single();
      const { data, error } = await q;
      if (error) return fallo(error, 'Canción');
      cerrarModal(); toast(c ? 'Canción actualizada' : 'Canción creada');
      if (c) rutear(); else location.hash = '#/cancion/' + data.id;
    });
  };
}

async function vistaCancion(ctx) {
  cargando('Canción', { atras: '#/canciones' });
  const id = ctx.id;
  const setId = ctx.q.get('set');
  const [rc, rn, rt, rs, rp] = await Promise.all([
    conCache('cancion:' + id, sb.from('canciones').select('*').eq('id', id).maybeSingle()),
    conCache('notas:' + id, sb.from('notas_cancion').select('*').eq('cancion_id', id)),
    conCache('tonos:' + id, sb.from('tonos_cantante').select('*').eq('cancion_id', id)),
    setId ? conCache('items:' + setId, sb.from('setlist_items').select(selItems()).eq('setlist_id', setId).order('orden')) : Promise.resolve({ data: null }),
    conCache('partituras:' + id, sb.from('partituras').select('*').eq('cancion_id', id).order('created_at')),
  ]);
  if (!ctx.vigente()) return;
  const err = rc.error || rn.error || rt.error || rs.error;
  if (err) return fallo(err, 'Canción');
  const usoC = (await cargarHistorial()).get(id);
  if (!ctx.vigente()) return;
  const c = rc.data;
  if (!c) { app.innerHTML = encabezado('Canción', { atras: '#/canciones' }) + '<div class="vacio">Esta canción ya no existe.</div>'; return; }

  const notas = Object.fromEntries((rn.data || []).map(n => [n.instrumento, n]));
  const partituras = rp.error ? [] : (rp.data || []);
  const ordenPart = p => (p.instrumento === st.perfil.instrumento ? 0 : p.instrumento === 'bateria' ? 1 : 2);
  partituras.sort((a, b) => ordenPart(a) - ordenPart(b));
  const tonos = (rt.data || []).sort((a, b) => nombreDe(a.cantante_id).localeCompare(nombreDe(b.cantante_id)));
  const items = rs.data;
  const idx = items ? Math.max(0, items.findIndex((it, i) => it.cancion_id === id && (ctx.q.get('i') == null || i === +ctx.q.get('i')))) : -1;
  const itemSet = items?.[idx];
  const vivo = !!(setId && ctx.q.get('vivo') === '1' && !st.faltaV2);
  const irItem = i => { const it = items[i]; return `#/cancion/${it.cancion_id}?set=${setId}&i=${i}${it.tono ? '&tono=' + encodeURIComponent(it.tono) : ''}${vivo ? '&vivo=1' : ''}`; };

  const original = parseTono(c.tono_original) ? c.tono_original : null;
  const menor = !!parseTono(original)?.menor;
  let semis = 0;
  // En un día, manda el tono guardado en el repertorio (así se ve al instante cualquier cambio)
  const pedido = itemSet?.tono || ctx.q.get('tono');
  if (original && pedido && parseTono(pedido)) semis = distancia(original, pedido);
  let tabNota = NOTAS_TABS[st.perfil.instrumento] ? st.perfil.instrumento : 'general';
  let editandoNota = false;

  const tonoActual = () => (original ? transponerTono(original, semis) : null);
  const puedeTonos = () => esAdmin() || st.perfil.instrumento === 'voz' || tonos.some(t => t.cantante_id === st.uid);

  const pintar = () => {
    const actual = tonoActual();
    const bem = actual ? usaBemoles(actual) : false;
    const verCifrado = ajustes.vista === 'cifrado' && !!(c.letra || c.cifrado);
    const meta = [
      c.artista ? `<span class="tag">${esc(c.artista)}</span>` : '',
      original ? `<span class="tag">Original: ${esc(tonoTxt(original))}</span>` : '',
      c.bpm ? `<span class="tag">${c.bpm} BPM</span>` : '',
      c.compas ? `<span class="tag">${esc(c.compas)}</span>` : '',
      usoC ? `<span class="tag uso-tag ${frescura(usoC)}">🕒 ${esc(txtUltima(usoC.ultima_vez))} · ${usoC.veces_90d}× en 3 meses</span>` : '',
      ritmoDe(itemSet) || c.ritmo ? `<span class="tag">${esc(RITMOS[ritmoDe(itemSet) || c.ritmo])}</span>` : '',
      itemSet?.cantante_id ? `<span class="tag ok">🎤 ${esc(nombreDe(itemSet.cantante_id))}</span>` : '',
    ].join('');
    const lista = menor ? TONOS_MENORES : TONOS_MAYORES;
    const derecha = esAdmin() ? `<button class="btn-ico" data-acc="editar" aria-label="Editar">✏️</button>` : '';
    const miInstr = st.perfil.instrumento;
    const misNotas = [notas.general?.contenido ? ['General', notas.general.contenido] : null,
      miInstr !== 'general' && notas[miInstr]?.contenido ? [NOTAS_TABS[miInstr], notas[miInstr].contenido] : null].filter(Boolean);
    app.innerHTML = encabezado(c.titulo, { atras: setId ? `#/dia/${setId}` : '#/canciones', derecha }) + `
      ${vivo ? `<button class="chip vivo ${st.seguirVivo ? 'activo' : ''}" data-acc="seguir" style="margin-bottom:10px">
        <span class="punto-vivo"></span>${st.seguirVivo ? (esAdmin() ? 'En vivo · tú controlas' : 'Siguiendo en vivo') : 'Libre · toca para volver al en vivo'}</button>` : ''}
      <div class="cancion-meta">${meta}</div>
      ${itemSet?.notas ? `<div class="card" style="padding:10px 12px">📝 ${esc(itemSet.notas)}</div>` : ''}
      <div class="controles">
        <div class="tono-actual">
          <button class="btn-ico" data-acc="bajar" aria-label="Bajar medio tono">−</button>
          ${original
            ? `<select id="selTono" aria-label="Tono">${lista.map(t => `<option value="${t}" ${t === actual ? 'selected' : ''}>${esc(tonoTxt(t))}</option>`).join('')}</select>`
            : `<span class="tono-pill">${semis > 0 ? '+' : ''}${semis}</span>`}
          <button class="btn-ico" data-acc="subir" aria-label="Subir medio tono">+</button>
        </div>
        <span class="sep"></span>
        <button class="btn-ico" data-acc="acordes" title="Mostrar/ocultar acordes" style="${ajustes.acordes ? '' : 'opacity:.45'}">🎸</button>
        <button class="btn-ico" data-acc="fuente-" aria-label="Letra más pequeña" style="font-size:13px">A−</button>
        <button class="btn-ico" data-acc="fuente+" aria-label="Letra más grande">A+</button>
      </div>
      ${original ? `<div class="cantantes">
        <button class="chip ${semis === 0 ? 'activo' : ''}" data-acc="tono" data-tono="${esc(original)}">Original <b>${esc(tonoTxt(original))}</b></button>
        ${tonos.map(t => `<button class="chip ${parseTono(t.tono) && distancia(original, t.tono) === semis && semis !== 0 ? 'activo' : ''}" data-acc="tono" data-tono="${esc(t.tono)}" title="${esc(t.notas || '')}">${esc(nombreDe(t.cantante_id))} <b>${esc(tonoTxt(t.tono))}</b></button>`).join('')}
        ${puedeTonos() ? `<button class="chip" data-acc="tonos">🎤 ${tonos.length ? 'Tonos' : 'Guardar tono'}</button>` : ''}
      </div>
      ${setId && itemSet && esAdmin() && actual && actual !== (itemSet.tono || original) ? `<div class="card guardar-tono">
        <span>Tono de este día: <b>${esc(tonoTxt(itemSet.tono || original))}</b> → <b>${esc(tonoTxt(actual))}</b></span>
        <button class="btn prim sm" data-acc="guardar-tono-dia">💾 Guardar${itemSet.cantante_id ? ` para ${esc(nombreCorto(itemSet.cantante_id))}` : ''}</button>
      </div>` : ''}` : (esAdmin() ? `<p class="ayuda">Define el tono original (✏️) para poder guardar tonos por cantante.</p>` : '')}
      ${misNotas.map(([k, v]) => `<div class="card nota-mia"><b>📝 ${esc(k)}:</b> ${esc(v)}</div>`).join('')}
      ${partituras.some(p => p.instrumento === miInstr) ? `<button class="btn sm" style="margin-bottom:10px" data-acc="ver-part" data-instr="${esc(miInstr)}">📄 Ver mi partitura (${esc(INSTRUMENTOS[miInstr] || miInstr)})</button>` : ''}
      ${c.letra || c.cifrado ? `<div class="segmentado vista-tg">
        <button data-acc="vista" data-v="letra" class="${verCifrado ? '' : 'activo'}">📝 Letra</button>
        <button data-acc="vista" data-v="cifrado" class="${verCifrado ? 'activo' : ''}">🎼 Cifrado</button>
        ${verCifrado && esAdmin() ? '<button data-acc="editar-cifrado">✏️ Ajustar</button>' : ''}
      </div>` : ''}
      ${verCifrado ? (() => {
        const texto = c.cifrado || generarCifrado(c.letra);
        const grilla = texto ? renderCifrado(texto, { semis, bemoles: bem, latino: ajustes.latino }) : '';
        return `<div class="letra cf-wrap" style="--fuente-letra:${ajustes.fuente}px">
          <div class="cf-top"><span>${esc(c.compas || '4/4')}</span><b>${esc(c.titulo)}</b><span>${actual ? esc(tonoTxt(actual)) : ''}${c.bpm ? ` · ${c.bpm} bpm` : ''}</span></div>
          ${grilla || '<div class="vacio">La letra no tiene acordes para armar el cifrado.</div>'}
          ${grilla && !c.cifrado ? `<p class="ayuda">Vista automática: 1 acorde = 1 compás.${esAdmin() ? ' Toca <b>✏️ Ajustar</b> para corregirla.' : ''}</p>` : ''}
        </div>`;
      })() : `<div class="letra ${ajustes.acordes ? '' : 'sin-acordes'}" style="--fuente-letra:${ajustes.fuente}px">
        ${c.letra ? renderLetra(c.letra, { semis, bemoles: bem, acordes: ajustes.acordes, latino: ajustes.latino }) : '<div class="vacio">Sin letra todavía.</div>'}
      </div>`}
      <div class="seccion-t">Notas por instrumento</div>
      <div class="segmentado">${Object.entries(NOTAS_TABS).map(([k, v]) =>
        `<button data-acc="tab" data-tab="${k}" class="${k === tabNota ? 'activo' : ''}">${esc(v)}${notas[k]?.contenido ? ' •' : ''}</button>`).join('')}</div>
      <div class="notas-instr">${editandoNota
        ? `<textarea id="txtNota" maxlength="4000" placeholder="Ej: entrar en el coro, cortes en el puente, patrón…">${esc(notas[tabNota]?.contenido)}</textarea>
           <div class="fila" style="margin-top:8px"><button class="btn" data-acc="cancelar-nota">Cancelar</button><button class="btn prim" data-acc="guardar-nota">Guardar nota</button></div>`
        : `<div class="nota-vista ${notas[tabNota]?.contenido ? '' : 'vacia'}">${esc(notas[tabNota]?.contenido || 'Sin notas para ' + NOTAS_TABS[tabNota].toLowerCase() + '.')}</div>
           <button class="btn sm" style="margin-top:8px" data-acc="editar-nota">✏️ ${notas[tabNota]?.contenido ? 'Editar' : 'Agregar'} nota</button>
           ${notas[tabNota]?.updated_at ? `<span class="ayuda" style="margin-left:8px">${esc(nombreDe(notas[tabNota].autor_id))} · ${haceCuanto(notas[tabNota].updated_at)}</span>` : ''}`}
      </div>
      <div class="seccion-t">📄 Partituras</div>
      ${partituras.length ? `<div class="partituras">${partituras.map(p => `
        <div class="part-item">
          ${p.tipo === 'imagen'
            ? `<img src="${esc(p.url)}" alt="" loading="lazy" data-acc="ver-part" data-instr="${esc(p.instrumento)}">`
            : `<button class="part-doc" data-acc="abrir-part" data-id="${p.id}">${p.tipo === 'pdf' ? '📄 PDF' : '🔗 Link'}</button>`}
          <div class="part-info"><b>${ICON_INSTR[p.instrumento] || '📄'} ${esc(INSTRUMENTOS[p.instrumento] || p.instrumento)}</b>
            <small>${esc(p.titulo || '')}${p.titulo ? ' · ' : ''}${esc(nombreDe(p.subido_por))}</small></div>
          ${p.subido_por === st.uid || esAdmin() ? `<button class="x" data-acc="borrar-part" data-id="${p.id}" aria-label="Eliminar">🗑️</button>` : ''}
        </div>`).join('')}</div>` : '<p class="ayuda">Aún no hay partituras para esta canción.</p>'}
      <button class="btn sm" data-acc="subir-part">＋ Subir partitura</button>
      ${c.video_url ? `<div class="seccion-t">Referencia</div>${embedVideo(c.video_url)}` : ''}
      ${esAdmin() ? `<button class="btn peligro blk" data-acc="borrar" style="margin-top:28px">Eliminar canción</button>` : ''}
      ${items ? `<div style="height:56px"></div>` : ''}`;

    // Navegación dentro del ensayo
    $('.nav-set')?.remove();
    if (items && items.length > 1) {
      const nav = document.createElement('div');
      nav.className = 'nav-set';
      nav.innerHTML = `<div>
        <a class="btn-ico" ${idx > 0 ? `href="${irItem(idx - 1)}"` : 'style="opacity:.3"'} aria-label="Anterior">‹</a>
        <span>${vivo ? '<span class="punto-vivo"></span>' : ''}${idx + 1} / ${items.length}</span>
        <a class="btn-ico" ${idx < items.length - 1 ? `href="${irItem(idx + 1)}"` : 'style="opacity:.3"'} aria-label="Siguiente">›</a></div>`;
      // Un seguidor que navega por su cuenta pasa a modo libre
      nav.onclick = e => { if (vivo && !esAdmin() && e.target.closest('a[href]')) st.seguirVivo = false; };
      document.body.appendChild(nav);
      st.limpiar.push(() => nav.remove());
    }
  };
  pintar();

  // ---- Modo en vivo ----
  if (vivo) {
    if (esAdmin() && st.seguirVivo) {
      // El admin que navega controla lo que ven los demás
      sb.from('en_vivo').update({ indice: idx, cancion_id: id, tono: itemSet?.tono ?? null, actualizado_por: st.uid })
        .eq('setlist_id', setId).eq('activo', true).then(({ error }) => error && fallo(error, 'En vivo'));
    }
    const canal = sb.channel('vivo-' + setId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'en_vivo', filter: `setlist_id=eq.${setId}` }, ({ new: v }) => {
        if (!ctx.vigente()) return;
        if (!v.activo) { toast('El en vivo terminó'); location.hash = irItem(idx).replace('&vivo=1', ''); return; }
        if (st.seguirVivo && v.actualizado_por !== st.uid && v.indice !== idx && items[v.indice]) location.hash = irItem(v.indice);
      })
      .subscribe();
    st.limpiar.push(() => sb.removeChannel(canal));
  }

  app.onchange = e => {
    if (e.target.id === 'selTono') { semis = distancia(original, e.target.value); pintar(); }
  };
  app.onclick = async e => {
    const el = e.target.closest('[data-acc]');
    if (!el) return;
    const acc = el.dataset.acc;
    if (acc === 'seguir') {
      st.seguirVivo = !st.seguirVivo;
      if (st.seguirVivo) {
        const { data: v } = await sb.from('en_vivo').select('*').eq('setlist_id', setId).maybeSingle();
        if (!v?.activo) { toast('El en vivo ya terminó'); location.hash = irItem(idx).replace('&vivo=1', ''); return; }
        if (esAdmin()) { rutear(); return; }
        if (v.indice !== idx && items[v.indice]) { location.hash = irItem(v.indice); return; }
      }
      pintar();
    }
    else if (acc === 'subir') { semis = ((semis + 1 + 6) % 12 + 12) % 12 - 6; pintar(); }
    else if (acc === 'bajar') { semis = ((semis - 1 + 6) % 12 + 12) % 12 - 6; pintar(); }
    else if (acc === 'tono') { semis = distancia(original, el.dataset.tono); pintar(); }
    else if (acc === 'acordes') { ajustes.acordes = !ajustes.acordes; guardarAjustes(); pintar(); }
    else if (acc === 'fuente+' || acc === 'fuente-') {
      ajustes.fuente = Math.min(34, Math.max(13, ajustes.fuente + (acc === 'fuente+' ? 2 : -2)));
      guardarAjustes(); $('.letra')?.style.setProperty('--fuente-letra', ajustes.fuente + 'px');
    }
    else if (acc === 'vista') { ajustes.vista = el.dataset.v; guardarAjustes(); pintar(); }
    else if (acc === 'editar-cifrado') modalCifrado(c, () => pintar());
    else if (acc === 'tab') { tabNota = el.dataset.tab; editandoNota = false; pintar(); }
    else if (acc === 'editar-nota') { editandoNota = true; pintar(); $('#txtNota')?.focus(); }
    else if (acc === 'cancelar-nota') { editandoNota = false; pintar(); }
    else if (acc === 'guardar-nota') {
      const contenido = $('#txtNota').value.trim();
      await ocupado(el, async () => {
        const { data, error } = await sb.from('notas_cancion')
          .upsert({ cancion_id: id, instrumento: tabNota, contenido, autor_id: st.uid }, { onConflict: 'cancion_id,instrumento' })
          .select().single();
        if (error) return fallo(error, 'Nota');
        notas[tabNota] = data; editandoNota = false; pintar(); toast('Nota guardada');
      });
    }
    else if (acc === 'tonos') modalTonos(c, tonos, () => rutear(), itemSet?.cantante_id);
    else if (acc === 'guardar-tono-dia') ocupado(el, async () => {
      const tono = tonoActual();
      const { error } = await sb.from('setlist_items').update({ tono }).eq('id', itemSet.id);
      if (error) return fallo(error, 'Tono');
      if (itemSet.cantante_id) {
        // Guarda también el tono del cantante (la base lo copia a sus próximos días)
        const { error: e2 } = await sb.from('tonos_cantante')
          .upsert({ cancion_id: c.id, cantante_id: itemSet.cantante_id, tono }, { onConflict: 'cancion_id,cantante_id' });
        if (e2) return fallo(e2, 'Tono');
      }
      itemSet.tono = tono;
      toast(itemSet.cantante_id ? `Tono guardado para ${nombreCorto(itemSet.cantante_id)}` : 'Tono guardado para este día');
      rutear();
    });
    else if (acc === 'ver-part') verPartituras(partituras.filter(p => p.instrumento === el.dataset.instr));
    else if (acc === 'abrir-part') abrirArchivo(partituras.find(p => p.id === el.dataset.id));
    else if (acc === 'subir-part') modalPartitura(c);
    else if (acc === 'borrar-part') {
      const p = partituras.find(x => x.id === el.dataset.id);
      if (!confirm('¿Eliminar esta partitura?')) return;
      const { error } = await sb.from('partituras').delete().eq('id', p.id);
      if (error) return fallo(error, 'Partitura');
      if (p.ruta) sb.storage.from('partituras').remove([p.ruta]);
      toast('Partitura eliminada'); rutear();
    }
    else if (acc === 'editar') modalCancion(c);
    else if (acc === 'borrar') {
      if (!confirm(`¿Eliminar "${c.titulo}"? También se borran sus notas, tonos y su lugar en los ensayos.`)) return;
      const { error } = await sb.from('canciones').delete().eq('id', id);
      if (error) return fallo(error, 'Canción');
      toast('Canción eliminada'); location.hash = '#/canciones';
    }
  };
}

// ---------- partituras ----------
// ---------- editor de cifrado en compases ----------
function modalCifrado(c, alGuardar) {
  const inicial = c.cifrado || generarCifrado(c.letra);
  const body = abrirModal('Cifrado en compases', `
    <form id="fCif">
      <p class="ayuda" style="margin-top:0">Escribe en el tono original${c.tono_original ? ` (<b>${esc(tonoTxt(c.tono_original))}</b>)` : ''}; se transpone solo.</p>
      <pre class="cf-ayuda">${esc(AYUDA_CIFRADO)}</pre>
      <textarea name="cifrado" class="mono cf-editor" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(inicial)}</textarea>
      <p class="ayuda" id="cfErr"></p>
      <div class="fila">
        <button class="btn" type="button" id="bGenerar">⚡ Regenerar desde la letra</button>
        ${c.cifrado ? '<button class="btn" type="button" id="bAuto">↺ Volver a automático</button>' : ''}
      </div>
      <div class="seccion-t">Vista previa</div>
      <div class="letra cf-wrap cf-previa" id="cfPrevia"></div>
      <button class="btn prim blk" type="submit">Guardar cifrado</button>
    </form>`);
  const form = $('#fCif', body), ta = form.cifrado;
  const previa = () => {
    const errs = erroresCifrado(ta.value);
    $('#cfErr', body).textContent = errs.length ? `⚠️ No reconozco: ${errs.join(', ')}` : '';
    $('#cfPrevia', body).innerHTML = renderCifrado(ta.value, { latino: ajustes.latino }) || '<div class="vacio">Sin compases.</div>';
  };
  ta.oninput = previa;
  previa();
  $('#bGenerar', body).onclick = () => {
    if (ta.value.trim() && !confirm('¿Reemplazar lo escrito por un borrador nuevo desde la letra?')) return;
    ta.value = generarCifrado(c.letra); previa();
  };
  const guardar = async valor => {
    const { error } = await sb.from('canciones').update({ cifrado: valor }).eq('id', c.id);
    if (error) return fallo(error, 'Cifrado');
    c.cifrado = valor; cerrarModal(); toast('Cifrado guardado'); alGuardar?.();
  };
  const ba = $('#bAuto', body);
  if (ba) ba.onclick = () => confirm('¿Borrar el cifrado ajustado y usar la vista automática?') && guardar(null);
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), () => guardar(ta.value.trim() || null));
  };
}

function verPartituras(lista) {
  const imgs = lista.filter(p => p.tipo === 'imagen');
  const otros = lista.filter(p => p.tipo !== 'imagen');
  if (!imgs.length && otros.length === 1) return abrirArchivo(otros[0]);
  const body = abrirModal('', `
    <div class="visor-part">
      <button class="visor-cerrar" data-cerrar aria-label="Cerrar">×</button>
      ${imgs.map(p => `<img src="${esc(p.url)}" alt="${esc(p.titulo || 'Partitura')}">`).join('')}
      ${otros.map(p => `<button class="btn blk" data-doc="${p.id}">${p.tipo === 'pdf' ? '📄 Abrir PDF' : '🔗 Abrir link'} ${esc(p.titulo || '')}</button>`).join('')}
    </div>`, { visor: true });
  body.querySelectorAll('[data-cerrar]').forEach(b => (b.onclick = cerrarModal));
  body.querySelectorAll('[data-doc]').forEach(b => (b.onclick = () => abrirArchivo(otros.find(p => p.id === b.dataset.doc))));
}

async function abrirArchivo(p) {
  if (!p) return;
  if (p.tipo !== 'pdf') return window.open(p.url, '_blank', 'noopener');
  // PDF: usar la copia guardada si existe (sirve sin internet)
  try {
    const r = (await caches.match(p.url)) || (await fetch(p.url));
    const u = URL.createObjectURL(await r.blob());
    if (!window.open(u, '_blank')) location.href = u;
  } catch { window.open(p.url, '_blank', 'noopener'); }
}

function modalPartitura(c) {
  const def = INSTRUMENTOS[st.perfil.instrumento] && st.perfil.instrumento !== 'voz' ? st.perfil.instrumento : 'bateria';
  const body = abrirModal('Subir partitura', `
    <form id="fPart">
      <p class="ayuda" style="margin-top:0">${esc(c.titulo)}</p>
      <label>Instrumento</label><select name="instrumento">${opcionesInstrumento(def)}</select>
      <label>Título (opcional)</label><input name="titulo" maxlength="80" placeholder="Ej: Groove del coro, Hoja 1">
      <div class="segmentado" id="segOrigen" style="margin-top:14px">
        <button type="button" data-o="archivo" class="activo">📷 Foto o PDF</button>
        <button type="button" data-o="link">🔗 Link</button>
      </div>
      <div id="oArchivo">
        <input type="file" name="archivos" accept="image/*,application/pdf" multiple>
        <p class="ayuda">Puedes tomar la foto con la cámara o elegir varias páginas a la vez. Máx. 15 MB por archivo.</p>
      </div>
      <div id="oLink" hidden>
        <input name="url" type="url" inputmode="url" placeholder="https://drive.google.com/…">
        <p class="ayuda">En Drive, comparte como "Cualquier persona con el enlace".</p>
      </div>
      <button class="btn prim blk" type="submit">Subir</button>
    </form>`);
  const form = $('#fPart', body);
  let origen = 'archivo';
  $('#segOrigen', body).onclick = e => {
    const b = e.target.closest('[data-o]'); if (!b) return;
    origen = b.dataset.o;
    body.querySelectorAll('[data-o]').forEach(x => x.classList.toggle('activo', x === b));
    $('#oArchivo', body).hidden = origen !== 'archivo';
    $('#oLink', body).hidden = origen !== 'link';
  };
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const instrumento = form.instrumento.value;
      const titulo = form.titulo.value.trim() || null;
      const filas = [];
      try {
        if (origen === 'link') {
          const url = urlSegura(form.url.value.trim());
          if (!url) return toast('El link no es válido', true);
          filas.push({ cancion_id: c.id, instrumento, titulo, tipo: 'link', url, subido_por: st.uid });
        } else {
          const archivos = [...form.archivos.files];
          if (!archivos.length) return toast('Elige una foto o un PDF', true);
          for (const [i, f] of archivos.entries()) {
            const esPdf = f.type === 'application/pdf';
            const blob = esPdf ? f : await comprimirImagen(f, 2400, 0.9);
            if (blob.size > 15 * 1024 * 1024) { toast(`${f.name} pesa más de 15 MB`, true); continue; }
            const ext = esPdf ? 'pdf' : blob.type === 'image/png' ? 'png' : blob.type === 'image/heic' ? 'heic' : 'jpg';
            const ruta = `${st.uid}/${c.id}-${Date.now()}-${i}.${ext}`;
            const { error } = await sb.storage.from('partituras').upload(ruta, blob, { contentType: blob.type || (esPdf ? 'application/pdf' : 'image/jpeg') });
            if (error) throw error;
            filas.push({
              cancion_id: c.id, instrumento, subido_por: st.uid, ruta,
              titulo: archivos.length > 1 ? `${titulo || 'Página'} ${i + 1}` : titulo,
              tipo: esPdf ? 'pdf' : 'imagen',
              url: sb.storage.from('partituras').getPublicUrl(ruta).data.publicUrl,
            });
          }
        }
        if (!filas.length) return;
        const { error } = await sb.from('partituras').insert(filas);
        if (error) throw error;
        cerrarModal(); toast(filas.length > 1 ? `${filas.length} páginas subidas` : 'Partitura subida'); rutear();
      } catch (err) { fallo(err, 'Partitura'); }
    });
  };
}

function modalTonos(c, tonos, alGuardar, preCantante) {
  const opcionesCantante = (esAdmin() ? cantantes() : [st.perfil])
    .map(p => `<option value="${p.id}">${esc(p.nombre)}${p.instrumento ? ' · ' + esc(INSTRUMENTOS[p.instrumento] || '') : ''}</option>`).join('');
  const editable = t => esAdmin() || t.cantante_id === st.uid;
  const body = abrirModal('Tonos por cantante', `
    <p class="ayuda" style="margin-top:0">${esc(c.titulo)} · original ${esc(tonoTxt(c.tono_original))}</p>
    <div class="lista">${tonos.map(t => `
      <div class="item" style="cursor:default">
        <span class="tono-pill">${esc(tonoTxt(t.tono))}</span>
        <div class="info"><b>${esc(nombreDe(t.cantante_id))}</b><small>${esc(t.notas || haceCuanto(t.updated_at))}</small></div>
        ${editable(t) ? `<button class="btn-ico" data-borrar="${t.id}" aria-label="Eliminar">🗑️</button>` : ''}
      </div>`).join('') || '<p class="ayuda">Aún no hay tonos guardados.</p>'}</div>
    <form id="fTono" style="margin-top:8px">
      <div class="fila">
        <div><label>Cantante</label><select name="cantante_id" required>${opcionesCantante}</select></div>
        <div><label>Tono</label><select name="tono" required>${opcionesTono('', parseTono(c.tono_original)?.menor ? TONOS_MENORES : TONOS_MAYORES, 'Elige…')}</select></div>
      </div>
      <label>Nota (opcional)</label><input name="notas" maxlength="200" placeholder="Ej: con capo 2, baja en el puente">
      <button class="btn prim blk">Guardar tono</button>
    </form>`);
  const form = $('#fTono', body);
  const precargar = () => {
    const t = tonos.find(x => x.cantante_id === form.cantante_id.value);
    form.tono.value = t?.tono || '';
    form.notas.value = t?.notas || '';
  };
  if (preCantante && form.cantante_id.querySelector(`option[value="${preCantante}"]`)) form.cantante_id.value = preCantante;
  form.cantante_id.onchange = precargar; precargar();
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('button'), async () => {
      const f = Object.fromEntries(new FormData(form));
      const { error } = await sb.from('tonos_cantante')
        .upsert({ cancion_id: c.id, cantante_id: f.cantante_id, tono: f.tono, notas: f.notas.trim() || null }, { onConflict: 'cancion_id,cantante_id' });
      if (error) return fallo(error, 'Tono');
      cerrarModal(); toast('Tono guardado · se aplicó a sus próximos días'); alGuardar();
    });
  };
  body.querySelectorAll('[data-borrar]').forEach(b => (b.onclick = async () => {
    if (!confirm('¿Eliminar este tono?')) return;
    const { error } = await sb.from('tonos_cantante').delete().eq('id', b.dataset.borrar);
    if (error) return fallo(error, 'Tono');
    cerrarModal(); toast('Tono eliminado'); alGuardar();
  }));
}

// =====================================================================
// AGENDA: calendario, días de servicio, equipo y planificación
// =====================================================================
const DIAS_SEM = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DIAS_INI = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
const ICON_ESTADO = { confirmado: '✅', por_confirmar: '🤔', rechazado: '❌', pendiente: '⏳' };
const TXT_ESTADO = { confirmado: 'Puede', por_confirmar: 'Por confirmar', rechazado: 'No puede', pendiente: 'Sin responder' };
const SIN_CONFIRMAR = ['pendiente', 'por_confirmar'];
const TOAST_ESTADO = { confirmado: '¡Gracias! Confirmado ✅', por_confirmar: 'Anotado: por confirmar 🤔', rechazado: 'Avisamos que no puedes ❌' };
/** Avisa si falta ejecutar 009 (estado nuevo o recordatorios). Devuelve true si era ese el error. */
function avisoV9(error) {
  const m = error?.message || '';
  if (error?.code === '23514' || error?.code === 'PGRST202' || /asignaciones_estado_check|recordar_pendientes/.test(m)) {
    toast(esAdmin() ? 'Ejecuta supabase/009_confirmaciones_recordatorios.sql en Supabase' : 'Esta opción aún no está activada', true);
    return true;
  }
  return false;
}
/** Botones Puedo / Por confirmar / No puedo. actual = estado actual (para resaltar). */
const botonesEstado = (acc, extra, actual, corto = false) => `
  <button class="btn sm ${actual === 'confirmado' ? 'prim' : ''}" data-acc="${acc}" ${extra} data-estado="confirmado">✅${corto ? '' : ' Puedo'}</button>
  <button class="btn sm ${actual === 'por_confirmar' ? 'aviso' : ''}" data-acc="${acc}" ${extra} data-estado="por_confirmar" title="Por confirmar">🤔${corto ? '' : ' Por confirmar'}</button>
  <button class="btn sm ${actual === 'rechazado' ? 'peligro' : ''}" data-acc="${acc}" ${extra} data-estado="rechazado" title="No puedo">❌${corto ? '' : ' No puedo'}</button>`;
const SEL_ASIG = () => (st.faltaV4 ? 'id, perfil_id, rol, estado' : 'id, perfil_id, rol, estado, dirige');
const selDia = () => `*, asignaciones(${SEL_ASIG()})`;
const SEL_ITEMS_BASE = '*, cancion:canciones(id, titulo, artista, tono_original)';
const selItems = () => (st.faltaV6 ? SEL_ITEMS_BASE : '*, cancion:canciones(id, titulo, artista, tono_original, ritmo)');
// ---------- ritmo (rápida / lenta) ----------
const RITMOS = { rapida: '⚡ Rápida', lenta: '🕊️ Lenta' };
const RITMOS_PL = { rapida: '⚡ Rápidas', lenta: '🕊️ Lentas', '': '🎵 Sin definir' };
const ICON_RITMO = { rapida: '⚡', lenta: '🕊️' };
const ritmoDe = it => it?.ritmo || it?.cancion?.ritmo || '';
const ORDEN_RITMO = { rapida: 0, lenta: 1, '': 2 };
const hayRitmo = items => items.some(i => ritmoDe(i));
/** HTML del buscador de canciones (reemplaza al <select>, que en iPhone no deja buscar). */
const htmlBuscadorCanciones = (name = 'cancion_id') => `
  <div class="bc">
    <input type="hidden" name="${name}">
    <div class="bc-sel item" hidden></div>
    <div class="bc-busca">
      <div class="buscador" style="margin:0 0 6px"><input type="search" class="bc-q" placeholder="Buscar por nombre, artista o letra…" autocomplete="off" enterkeyhint="search"></div>
      <div class="bc-res"></div>
    </div>
  </div>`;

/** Activa el buscador. etiqueta(c) agrega texto extra a cada resultado (p. ej. última vez usada). */
function iniciarBuscadorCanciones(caja, canciones, { valor = '', etiqueta = () => '', alElegir = () => {} } = {}) {
  const hid = caja.querySelector('input[type=hidden]'), q = caja.querySelector('.bc-q');
  const res = caja.querySelector('.bc-res'), sel = caja.querySelector('.bc-sel'), busca = caja.querySelector('.bc-busca');
  const sinAcordes = t => (t || '').replace(/\[[^\]]*\]/g, '');
  const idx = canciones.map(c => ({ c, tit: normalizar(`${c.titulo} ${c.artista || ''}`), letra: normalizar(sinAcordes(c.letra)) }));
  const pintar = () => {
    const palabras = normalizar(q.value).trim().split(/\s+/).filter(Boolean);
    if (!palabras.length) { res.innerHTML = '<p class="ayuda" style="text-align:center;margin:8px 0">✍️ Escribe el nombre, el artista o una frase de la letra</p>'; return; }
    const enTit = [], enLetra = [];
    for (const x of idx) {
      if (palabras.every(p => x.tit.includes(p))) enTit.push(x.c);
      else if (palabras.length && palabras.every(p => x.tit.includes(p) || x.letra.includes(p))) enLetra.push(x.c);
    }
    const fila = (c, deLetra) => `<button type="button" class="bc-op" data-id="${c.id}">
      <b>${ICON_RITMO[c.ritmo] ? ICON_RITMO[c.ritmo] + ' ' : ''}${esc(c.titulo)}</b>
      <small>${[c.artista, c.tono_original ? 'Tono ' + tonoTxt(c.tono_original) : '', etiqueta(c), deLetra ? '📝 coincide en la letra' : ''].filter(Boolean).map(esc).join(' · ')}</small></button>`;
    res.innerHTML = enTit.map(c => fila(c, false)).join('') + enLetra.map(c => fila(c, true)).join('')
      || '<p class="ayuda" style="text-align:center">Sin resultados</p>';
  };
  const elegir = (id, avisar = true) => {
    const c = canciones.find(x => x.id === id);
    hid.value = c ? c.id : '';
    sel.hidden = !c; busca.hidden = !!c;
    if (c) sel.innerHTML = `<div class="info"><b>${esc(c.titulo)}</b><small>${esc([c.artista, c.tono_original ? 'Tono ' + tonoTxt(c.tono_original) : ''].filter(Boolean).join(' · '))}</small></div>
      <button type="button" class="btn sm" data-cambiar style="margin:0">Cambiar</button>`;
    else { q.value = ''; pintar(); }
    if (avisar) alElegir(hid.value);
  };
  q.oninput = pintar;
  q.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); const p = res.querySelector('.bc-op'); if (p) elegir(p.dataset.id); } };
  res.onclick = e => { const b = e.target.closest('.bc-op'); if (b) elegir(b.dataset.id); };
  sel.onclick = e => { if (e.target.closest('[data-cambiar]')) { elegir(''); q.focus(); } };
  pintar();
  if (valor) elegir(valor, false);
  else setTimeout(() => q.focus(), 80);   // listo para escribir apenas se abre
  return { elegir, valor: () => hid.value };
}

/** Arrastrar filas .set-item por su agarradera [data-acc="drag"]. Llama alSoltar(ids) si cambió el orden. */
function activarArrastre(lista, alSoltar) {
  if (!lista) return;
  lista.addEventListener('pointerdown', e => {
    const h = e.target.closest('[data-acc="drag"]');
    if (!h || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const fila = h.closest('.set-item');
    const inicial = [...lista.querySelectorAll('.set-item')].map(f => f.dataset.id);
    let y0 = e.clientY + scrollY;
    h.setPointerCapture(e.pointerId);
    fila.classList.add('arrastrando'); lista.classList.add('ordenando');
    navigator.vibrate?.(15);
    const centro = el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    const mover = ev => {
      // desplazar la pantalla si se acerca a los bordes
      if (ev.clientY < 90) scrollBy(0, -12); else if (ev.clientY > innerHeight - 120) scrollBy(0, 12);
      fila.style.transform = `translateY(${ev.clientY + scrollY - y0}px)`;
      const c = centro(fila);
      const sig = fila.nextElementSibling, ant = fila.previousElementSibling;
      let antes = null;
      if (sig?.classList.contains('set-item') && c > centro(sig)) { antes = fila.offsetTop; sig.after(fila); }
      else if (ant?.classList.contains('set-item') && c < centro(ant)) { antes = fila.offsetTop; ant.before(fila); }
      if (antes !== null) {
        y0 += fila.offsetTop - antes;
        fila.style.transform = `translateY(${ev.clientY + scrollY - y0}px)`;
        lista.querySelectorAll('.set-item .num').forEach((n, k) => (n.textContent = k + 1));
      }
    };
    const soltar = () => {
      h.removeEventListener('pointermove', mover);
      h.removeEventListener('pointerup', soltar);
      h.removeEventListener('pointercancel', soltar);
      fila.style.transform = '';
      fila.classList.remove('arrastrando'); lista.classList.remove('ordenando');
      const ids = [...lista.querySelectorAll('.set-item')].map(f => f.dataset.id);
      if (ids.join() !== inicial.join()) alSoltar(ids);
    };
    h.addEventListener('pointermove', mover);
    h.addEventListener('pointerup', soltar);
    h.addEventListener('pointercancel', soltar);
  });
}

/** Reordena el repertorio de un día: primero rápidas, luego lentas, luego sin definir (respeta el orden dentro de cada grupo). */
async function ordenarPorRitmo(setId) {
  if (st.faltaV6) return false;
  const { data, error } = await sb.from('setlist_items').select(selItems()).eq('setlist_id', setId).order('orden');
  if (error || !data || !hayRitmo(data)) return false;
  const nuevo = [...data].sort((a, b) => ORDEN_RITMO[ritmoDe(a)] - ORDEN_RITMO[ritmoDe(b)] || a.orden - b.orden);
  const cambios = nuevo.map((it, k) => ({ it, k })).filter(({ it, k }) => it.orden !== k);
  if (!cambios.length) return false;
  await Promise.all(cambios.map(({ it, k }) => sb.from('setlist_items').update({ orden: k }).eq('id', it.id)));
  return true;
}
const pad = n => String(n).padStart(2, '0');
const claveDia = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoSinMs = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const mesActual = () => claveDia(new Date()).slice(0, 7);
const rangoMes = mes => { const [y, m] = mes.split('-').map(Number); return [new Date(y, m - 1, 1), new Date(y, m, 1)]; };
const moverMes = (mes, n) => { const [y, m] = mes.split('-').map(Number); return claveDia(new Date(y, m - 1 + n, 1)).slice(0, 7); };
const nombreMes = mes => { const [y, m] = mes.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('es-PA', { month: 'long', year: 'numeric' }); };
const fmtCorta = iso => new Date(iso).toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
const nombreCorto = id => { const p = (nombreDe(id) || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[1][0]}.` : p[0]; };
const misRoles = s => (s.asignaciones || []).filter(a => a.perfil_id === st.uid);
const ordenRol = r => { const i = Object.keys(ROLES).indexOf(r); return i < 0 ? 99 : i; };
/** Etiqueta de una asignación: una Voz marcada como "dirige" se muestra como Dirige. */
const etiquetaRol = a => (a.dirige ? '👑 Dirige' : ROLES[a.rol] || (a.rol === 'dirige' ? 'Dirige' : a.rol === 'coros' ? 'Voz' : a.rol));
const ordenAsig = (a, b) => ordenRol(a.rol) - ordenRol(b.rol) || (b.dirige === true) - (a.dirige === true);
/** Agrupa asignaciones por etiqueta (Dirige primero, luego Voz, luego instrumentos). */
function gruposRol(asig, roles) {
  const out = [];
  roles.forEach(r => {
    const as = asig.filter(a => a.rol === r);
    if (r === 'voz') {
      const d = as.filter(a => a.dirige), v = as.filter(a => !a.dirige);
      if (d.length) out.push(['Dirige', d]);
      if (v.length) out.push(['Voz', v]);
    } else if (as.length) out.push([ROLES[r] || r, as]);
  });
  return out;
}
const tipoDe = s => st.tipos.find(t => t.id === s.tipo_evento_id)
  || (s.tipo === 'ensayo' ? { nombre: 'Ensayo', emoji: '🎹', color: '#4fc38a' } : { nombre: 'Evento', emoji: '📅', color: '#e0b458' });
const esTipoEnsayo = t => /ensayo/i.test(t?.nombre || '');

async function cargarTipos() {
  const { data, error } = await conCache('tipos', sb.from('tipos_evento').select('*').order('orden'));
  st.faltaV2 = !!error && !esErrorRed(error);
  st.tipos = data || [];
  if (!st.faltaV2 && navigator.onLine) {
    const r4 = await sb.from('asignaciones').select('dirige').limit(1);
    st.faltaV4 = !!r4.error && !esErrorRed(r4.error);
    const r6 = await sb.from('setlist_items').select('ritmo').limit(1);
    st.faltaV6 = !!r6.error && !esErrorRed(r6.error);
  }
}

function avisoV2() {
  return `<div class="card" style="border-color:var(--peligro)">⚠️ La agenda necesita una actualización de la base de datos.
    ${esAdmin() ? 'Ejecuta <b>supabase/002_agenda.sql</b> en Supabase → SQL Editor.' : 'Avísale a un administrador.'}</div>`;
}

/** Fecha/hora de ensayo sugerida para un tipo y una fecha (formato datetime-local). */
function ensayoSugerido(t, fecha) {
  if (!t?.ensayo_hora || !fecha) return '';
  const d = new Date(`${fecha}T00:00`);
  const atras = t.ensayo_dia_semana == null ? 0 : (d.getDay() - t.ensayo_dia_semana + 7) % 7;
  d.setDate(d.getDate() - atras);
  return `${claveDia(d)}T${t.ensayo_hora.slice(0, 5)}`;
}

function etiquetaMia(s) {
  const mios = misRoles(s);
  if (!mios.length) return '';
  if (mios.some(a => a.estado === 'pendiente')) return '<span class="tag warn">Te toca · confirma</span>';
  if (mios.some(a => a.estado === 'por_confirmar')) return '<span class="tag warn">🤔 Por confirmar</span>';
  if (mios.every(a => a.estado === 'rechazado')) return '<span class="tag">No puedes</span>';
  return '<span class="tag ok">Te toca ✅</span>';
}

function filaDia(s, { ensayo = false } = {}) {
  const t = tipoDe(s);
  const f = new Date(ensayo ? s.ensayo_fecha : s.fecha);
  return `<a class="item" href="#/dia/${s.id}" style="border-left:3px solid ${esc(t.color)}">
    <div class="fecha-box"><small>${f.toLocaleDateString('es-PA', { month: 'short' }).replace('.', '')}</small><b>${f.getDate()}</b></div>
    <div class="info"><b>${ensayo ? '🎹 Ensayo · ' : esc(t.emoji) + ' '}${esc(s.titulo)}</b>
      <small>${DIAS_SEM[f.getDay()]} · ${fmtHora(f)}${!ensayo && s.ensayo_fecha ? ` · ensayo ${fmtCorta(s.ensayo_fecha)} ${fmtHora(s.ensayo_fecha)}` : ''}${s.lugar ? ' · ' + esc(s.lugar) : ''}</small></div>
    ${ensayo ? '' : etiquetaMia(s)}</a>`;
}

/** Tarjeta "Te toca servir" con botones de confirmación. */
function tarjetaPorConfirmar(asigs) {
  if (!asigs.length) return '';
  return `<div class="card confirmar">
    <div style="font-weight:800;margin-bottom:6px">🙋 Te toca servir</div>
    ${asigs.map(a => `
      <div class="conf-fila">
        <a href="#/dia/${a.setlist.id}" class="info"><b>${esc(tipoDe(a.setlist).emoji)} ${esc(a.setlist.titulo)}</b>
          <small>${fmtCorta(a.setlist.fecha)} · ${fmtHora(a.setlist.fecha)} · ${esc(etiquetaRol(a))}</small></a>
        ${botonesEstado('conf', `data-id="${a.id}"`, a.estado, true)}
      </div>`).join('')}
  </div>`;
}

async function responderAsignacion(id, estado) {
  const { error } = await sb.from('asignaciones').update({ estado }).eq('id', id);
  if (error) return avisoV9(error) || fallo(error, 'Confirmación');
  toast(TOAST_ESTADO[estado]);
  rutear();
}

async function misPendientes() {
  if (st.faltaV2) return [];
  const { data } = await conCache('pendientes', sb.from('asignaciones')
    .select(`${SEL_ASIG()}, setlist:setlists(id, titulo, fecha, tipo_evento_id, tipo)`)
    .eq('perfil_id', st.uid).in('estado', SIN_CONFIRMAR));
  const limite = Date.now() - 12 * 3600e3;
  return (data || []).filter(a => a.setlist && new Date(a.setlist.fecha) >= limite)
    .sort((a, b) => a.setlist.fecha.localeCompare(b.setlist.fecha));
}

/** Resumen compacto de un día (para el muro y para compartir). */
function resumenDia(s, items) {
  const asig = (s.asignaciones || []).filter(a => a.estado !== 'rechazado');
  const linea = roles => gruposRol(asig, roles)
    .map(([et, as]) => `<span class="rs-rol">${esc(et)}:</span> ${as.map(a => esc(nombreDe(a.perfil_id))).join(', ')}`).join(' · ');
  const canto = linea(ROLES_CANTO);
  const instr = linea(Object.keys(ROLES).filter(r => !ROLES_CANTO.includes(r)));
  const its = [...(items || [])].filter(i => i.cancion).sort((a, b) => a.orden - b.orden);
  return `<div class="resumen">
    <div>📅 <b>${fmtCorta(s.fecha)}</b> · ${fmtHora(s.fecha)}${s.ensayo_fecha ? `<br>🎹 Ensayo: ${fmtCorta(s.ensayo_fecha)} · ${fmtHora(s.ensayo_fecha)}` : ''}${s.lugar ? `<br>📍 ${esc(s.lugar)}` : ''}</div>
    ${canto ? `<div class="rs-bloque"><div class="rs-t">🎤 Cantores</div>${canto}</div>` : ''}
    ${instr ? `<div class="rs-bloque"><div class="rs-t">🎸 Instrumentistas</div>${instr}</div>` : ''}
    ${its.length ? `<div class="rs-bloque"><div class="rs-t">🎵 Canciones</div><ol>${its.map(i =>
      `<li>${ICON_RITMO[ritmoDe(i)] ? ICON_RITMO[ritmoDe(i)] + ' ' : ''}${esc(i.cancion.titulo)} — <b class="tono-txt">${esc(tonoTxt(i.tono || i.cancion.tono_original))}</b>${i.cantante_id ? ` <small>(${esc(nombreDe(i.cantante_id))})</small>` : ''}</li>`).join('')}</ol></div>` : ''}
  </div>`;
}

// ---------- vista: calendario ----------
async function vistaAgenda(ctx) {
  cargando('Agenda');
  if (st.faltaV2) { app.innerHTML = encabezado('Agenda') + avisoV2(); return; }
  const mes = ctx.q.get('mes') || mesActual();
  const [ini, fin] = rangoMes(mes);
  const a = isoSinMs(ini), b = isoSinMs(fin);
  const [rm, rp, pend] = await Promise.all([
    conCache('agenda:' + mes, sb.from('setlists').select(selDia()).or(`and(fecha.gte.${a},fecha.lt.${b}),and(ensayo_fecha.gte.${a},ensayo_fecha.lt.${b})`).order('fecha')),
    conCache('proximos', sb.from('setlists').select(selDia()).gte('fecha', isoSinMs(new Date(Date.now() - 12 * 3600e3))).order('fecha').limit(40)),
    misPendientes(),
  ]);
  if (!ctx.vigente()) return;
  if (rm.error && esErrorRed(rm.error) && rp.data) rm.data = rp.data, rm.error = null;   // sin internet: usar lo descargado
  if (rm.error || rp.error) return fallo(rm.error || rp.error, 'Agenda');

  const porDia = {};
  rm.data.forEach(s => {
    const f = new Date(s.fecha);
    if (f >= ini && f < fin) (porDia[claveDia(f)] ??= []).push({ s, ensayo: false });
    if (s.ensayo_fecha) {
      const e = new Date(s.ensayo_fecha);
      if (e >= ini && e < fin) (porDia[claveDia(e)] ??= []).push({ s, ensayo: true });
    }
  });
  const hoyK = claveDia(new Date());
  let sel = ctx.q.get('dia') || (mes === mesActual() ? hoyK : null);
  let soloMios = ctx.q.get('mios') === '1';
  const diasMes = new Date(fin - 1).getDate();

  const pintar = () => {
    let celdas = '<div class="cal-sem">' + DIAS_INI.map(d => `<span>${d}</span>`).join('') + '</div><div class="cal-grid">';
    for (let i = 0; i < ini.getDay(); i++) celdas += '<span></span>';
    for (let d = 1; d <= diasMes; d++) {
      const k = `${mes}-${pad(d)}`;
      const evs = porDia[k] || [];
      const mio = evs.some(x => !x.ensayo && misRoles(x.s).some(r => r.estado !== 'rechazado'));
      celdas += `<button class="cal-dia ${k === hoyK ? 'hoy' : ''} ${k === sel ? 'sel' : ''} ${mio ? 'mio' : ''}" data-dia="${k}">
        <span>${d}</span><i>${evs.slice(0, 3).map(x => {
          const c = esc(tipoDe(x.s).color);
          return `<b style="border-color:${c};background:${x.ensayo ? 'transparent' : c}"></b>`;
        }).join('')}</i></button>`;
    }
    celdas += '</div>';
    const delDia = sel ? (porDia[sel] || []) : [];
    const proximos = rp.data.filter(s => !soloMios || misRoles(s).length);
    app.innerHTML = encabezado('Agenda') + `
      ${tarjetaPorConfirmar(pend)}
      ${esAdmin() ? `<div class="admin-bar">
        <button class="btn sm prim" data-acc="nuevo">＋ Nuevo día</button>
        <button class="btn sm" data-acc="generar">🗓️ Generar mes</button>
        <a class="btn sm" href="#/plan?mes=${mes}">📋 Planificación</a>
        <button class="btn sm" data-acc="tipos">⚙️ Tipos y horarios</button>
      </div>` : ''}
      <div class="card cal">
        <div class="cal-head">
          <button class="btn-ico" data-mes="-1" aria-label="Mes anterior">‹</button>
          <b>${esc(nombreMes(mes))}</b>
          <button class="btn-ico" data-mes="1" aria-label="Mes siguiente">›</button>
        </div>
        ${celdas}
        <div class="cal-ley">${st.tipos.map(t => `<span><b style="background:${esc(t.color)}"></b>${esc(t.nombre)}</span>`).join('')}<span><b class="hueco"></b>Ensayo previo</span></div>
      </div>
      ${sel ? `<div class="seccion-t">${esc(new Date(sel + 'T12:00').toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
        <div class="lista">${delDia.map(x => filaDia(x.s, { ensayo: x.ensayo })).join('') || '<p class="ayuda">Nada programado este día.</p>'}</div>
        ${esAdmin() ? `<button class="btn sm" style="margin-top:8px" data-acc="nuevo" data-fecha="${sel}">＋ Programar este día</button>` : ''}` : ''}
      <div class="seccion-t" style="display:flex;justify-content:space-between;align-items:center"><span>Próximos</span>
        <span class="segmentado" style="margin:0"><button data-acc="mios" data-v="0" class="${soloMios ? '' : 'activo'}">Todos</button><button data-acc="mios" data-v="1" class="${soloMios ? 'activo' : ''}">Mis días</button></span></div>
      <div class="lista">${proximos.map(s => filaDia(s)).join('') || `<div class="vacio"><span class="grande">📅</span>${soloMios ? 'No tienes días asignados.' : 'No hay nada programado.'}</div>`}</div>`;
  };
  pintar();

  app.onclick = e => {
    const dia = e.target.closest('[data-dia]');
    if (dia) { sel = dia.dataset.dia; pintar(); return; }
    const m = e.target.closest('[data-mes]');
    if (m) { location.hash = `#/agenda?mes=${moverMes(mes, +m.dataset.mes)}`; return; }
    const el = e.target.closest('[data-acc]');
    if (!el) return;
    const acc = el.dataset.acc;
    if (acc === 'conf') responderAsignacion(el.dataset.id, el.dataset.estado);
    else if (acc === 'mios') { soloMios = el.dataset.v === '1'; pintar(); }
    else if (acc === 'nuevo') modalDia(null, el.dataset.fecha);
    else if (acc === 'generar') modalGenerarMes(mes);
    else if (acc === 'tipos') modalTipos();
  };
}

// ---------- modal: crear/editar día ----------
function modalDia(s, fechaPreset) {
  const x = s || {};
  const f0 = x.fecha ? aLocalInput(x.fecha) : '';
  const tipo0 = st.tipos.find(t => t.id === x.tipo_evento_id) || st.tipos.find(t => t.recurrente) || st.tipos[0];
  const fecha0 = f0.slice(0, 10) || fechaPreset || claveDia(new Date());
  const hora0 = f0.slice(11, 16) || tipo0?.hora?.slice(0, 5) || '';
  const ens0 = x.ensayo_fecha ? aLocalInput(x.ensayo_fecha) : (s ? '' : ensayoSugerido(tipo0, fecha0));
  const body = abrirModal(s ? 'Editar día' : 'Programar día', `
    <form id="fDia">
      <label>Tipo</label>
      <select name="tipo_evento_id">${st.tipos.map(t => `<option value="${t.id}" ${t.id === tipo0?.id ? 'selected' : ''}>${esc(t.emoji)} ${esc(t.nombre)}</option>`).join('')}</select>
      <label>Título</label><input name="titulo" required maxlength="120" value="${esc(x.titulo || tipo0?.nombre || '')}">
      <div class="fila">
        <div><label>Fecha</label><input name="fecha" type="date" required value="${fecha0}"></div>
        <div><label>Hora</label><input name="hora" type="time" required value="${hora0}"></div>
      </div>
      <label class="check"><input type="checkbox" name="conEnsayo" ${ens0 ? 'checked' : ''}> 🎹 Tiene ensayo previo</label>
      <div id="campoEns" ${ens0 ? '' : 'hidden'}><label>Fecha y hora del ensayo</label><input name="ensayo" type="datetime-local" value="${ens0}"></div>
      <label>Lugar</label><input name="lugar" maxlength="120" value="${esc(x.lugar)}">
      <label>Notas</label><textarea name="notas" maxlength="2000" placeholder="Vestimenta, indicaciones…">${esc(x.notas)}</textarea>
      <button class="btn prim blk" type="submit">${s ? 'Guardar' : 'Crear'}</button>
    </form>`);
  const form = $('#fDia', body);
  let ensTocado = !!s;
  form.ensayo.oninput = () => (ensTocado = true);
  const sugerir = () => {
    const t = st.tipos.find(t => t.id === form.tipo_evento_id.value);
    if (!ensTocado) {
      const sug = ensayoSugerido(t, form.fecha.value);
      form.ensayo.value = sug;
      form.conEnsayo.checked = !!sug;
      $('#campoEns', body).hidden = !sug;
    }
  };
  form.tipo_evento_id.onchange = () => {
    const t = st.tipos.find(t => t.id === form.tipo_evento_id.value);
    if (!s && st.tipos.some(o => o.nombre === form.titulo.value) || !form.titulo.value) form.titulo.value = t?.nombre || '';
    if (!s && t?.hora) form.hora.value = t.hora.slice(0, 5);
    sugerir();
  };
  form.fecha.onchange = sugerir;
  form.conEnsayo.onchange = () => { $('#campoEns', body).hidden = !form.conEnsayo.checked; ensTocado = true; };

  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = Object.fromEntries(new FormData(form));
      const t = st.tipos.find(t => t.id === f.tipo_evento_id);
      if (f.conEnsayo && !f.ensayo) return toast('Indica la fecha del ensayo', true);
      const datos = {
        tipo_evento_id: f.tipo_evento_id || null,
        tipo: esTipoEnsayo(t) ? 'ensayo' : 'evento',
        titulo: f.titulo.trim(),
        fecha: new Date(`${f.fecha}T${f.hora}`).toISOString(),
        ensayo_fecha: f.conEnsayo ? new Date(f.ensayo).toISOString() : null,
        lugar: f.lugar.trim() || null,
        notas: f.notas.trim() || null,
      };
      const { data, error } = s
        ? await sb.from('setlists').update(datos).eq('id', s.id).select('id').single()
        : await sb.from('setlists').insert({ ...datos, creado_por: st.uid }).select('id').single();
      if (error) return fallo(error, 'Día');
      cerrarModal(); toast('Guardado');
      if (s) rutear(); else location.hash = '#/dia/' + data.id;
    });
  };
}

// ---------- modal: generar mes ----------
function modalGenerarMes(mes) {
  const rec = st.tipos.filter(t => t.recurrente && t.dia_semana != null);
  if (!rec.length) return toast('No hay tipos recurrentes. Configúralos en ⚙️ Tipos y horarios', true);
  const body = abrirModal('Generar mes', `
    <form id="fGen">
      <label>Mes</label><input name="mes" type="month" required value="${mes}">
      <label>Crear automáticamente</label>
      ${rec.map(t => `<label class="check"><input type="checkbox" name="t" value="${t.id}" checked>
        ${esc(t.emoji)} ${esc(t.nombre)} — todos los ${DIAS_SEM[t.dia_semana].toLowerCase()} ${t.hora ? t.hora.slice(0, 5) : '(sin hora)'}${t.ensayo_hora ? ` · ensayo ${t.ensayo_dia_semana == null ? 'mismo día' : DIAS_SEM[t.ensayo_dia_semana].toLowerCase()} ${t.ensayo_hora.slice(0, 5)}` : ''}</label>`).join('')}
      <p class="ayuda">Los días que ya existan no se duplican. Después puedes editar cada día.</p>
      <button class="btn prim blk" type="submit">Generar</button>
    </form>`);
  const form = $('#fGen', body);
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const fd = new FormData(form);
      const elegidos = rec.filter(t => fd.getAll('t').includes(t.id));
      const m = fd.get('mes');
      const [ini, fin] = rangoMes(m);
      const { data: existentes, error: e1 } = await sb.from('setlists').select('tipo_evento_id, fecha')
        .gte('fecha', isoSinMs(ini)).lt('fecha', isoSinMs(fin));
      if (e1) return fallo(e1, 'Generar');
      const ya = new Set(existentes.map(x => `${x.tipo_evento_id}|${claveDia(new Date(x.fecha))}`));
      const filas = [];
      for (let d = new Date(ini); d < fin; d.setDate(d.getDate() + 1)) {
        const k = claveDia(d);
        for (const t of elegidos) {
          if (d.getDay() !== t.dia_semana || ya.has(`${t.id}|${k}`)) continue;
          const ens = ensayoSugerido(t, k);
          filas.push({
            titulo: t.nombre, tipo: esTipoEnsayo(t) ? 'ensayo' : 'evento', tipo_evento_id: t.id,
            fecha: new Date(`${k}T${(t.hora || '00:00').slice(0, 5)}`).toISOString(),
            ensayo_fecha: ens ? new Date(ens).toISOString() : null, creado_por: st.uid,
          });
        }
      }
      if (!filas.length) { cerrarModal(); return toast('Ese mes ya estaba generado'); }
      const { error } = await sb.from('setlists').insert(filas);
      if (error) return fallo(error, 'Generar');
      cerrarModal(); toast(`Se crearon ${filas.length} días`);
      const destino = `#/agenda?mes=${m}`;
      if (location.hash === destino) rutear(); else location.hash = destino;
    });
  };
}

// ---------- modal: tipos y horarios ----------
function modalTipos(editar) {
  if (editar !== undefined) return modalTipoForm(editar);
  const desc = t => [
    t.recurrente && t.dia_semana != null ? `Cada ${DIAS_SEM[t.dia_semana].toLowerCase()}` : 'Sin día fijo',
    t.hora ? t.hora.slice(0, 5) : '',
    t.ensayo_hora ? `ensayo ${t.ensayo_dia_semana == null ? 'mismo día' : DIAS_SEM[t.ensayo_dia_semana].toLowerCase()} ${t.ensayo_hora.slice(0, 5)}` : '',
  ].filter(Boolean).join(' · ');
  const body = abrirModal('Tipos y horarios', `
    <p class="ayuda" style="margin-top:0">Horarios predeterminados al programar o generar el mes. Cada día se puede ajustar después.</p>
    <div class="lista">${st.tipos.map(t => `
      <div class="item" data-tipo="${t.id}" style="border-left:3px solid ${esc(t.color)}">
        <span style="font-size:22px">${esc(t.emoji)}</span>
        <div class="info"><b>${esc(t.nombre)}</b><small>${esc(desc(t))}</small></div><span>✏️</span>
      </div>`).join('')}</div>
    <button class="btn blk" id="bNuevoTipo">＋ Nuevo tipo de día</button>`);
  body.querySelectorAll('[data-tipo]').forEach(el => (el.onclick = () => modalTipoForm(st.tipos.find(t => t.id === el.dataset.tipo))));
  $('#bNuevoTipo', body).onclick = () => modalTipoForm(null);
}

function modalTipoForm(t) {
  const x = t || { emoji: '⭐', color: '#c58af0', recurrente: false };
  const optDias = (sel, extra) => extra + DIAS_SEM.map((d, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${d}</option>`).join('');
  const ensSel = x.ensayo_hora ? (x.ensayo_dia_semana == null ? 'mismo' : x.ensayo_dia_semana) : '';
  const body = abrirModal(t ? 'Editar tipo de día' : 'Nuevo tipo de día', `
    <form id="fTipo">
      <div class="fila">
        <div style="flex:0 0 70px"><label>Emoji</label><input name="emoji" maxlength="4" required value="${esc(x.emoji)}"></div>
        <div><label>Nombre</label><input name="nombre" required maxlength="60" value="${esc(x.nombre)}"></div>
        <div style="flex:0 0 60px"><label>Color</label><input name="color" type="color" value="${esc(x.color)}" style="padding:4px;height:46px"></div>
      </div>
      <label class="check"><input type="checkbox" name="recurrente" ${x.recurrente ? 'checked' : ''}> Se repite cada semana (para "Generar mes")</label>
      <div class="fila">
        <div><label>Día</label><select name="dia_semana">${optDias(x.dia_semana, '<option value="">Sin día fijo</option>')}</select></div>
        <div><label>Hora</label><input name="hora" type="time" value="${x.hora ? x.hora.slice(0, 5) : ''}"></div>
      </div>
      <div class="fila">
        <div><label>Ensayo</label><select name="ensayo_dia">
          <option value="" ${ensSel === '' ? 'selected' : ''}>Sin ensayo fijo</option>
          <option value="mismo" ${ensSel === 'mismo' ? 'selected' : ''}>El mismo día</option>
          ${DIAS_SEM.map((d, i) => `<option value="${i}" ${ensSel === i ? 'selected' : ''}>${d} anterior</option>`).join('')}</select></div>
        <div><label>Hora de ensayo</label><input name="ensayo_hora" type="time" value="${x.ensayo_hora ? x.ensayo_hora.slice(0, 5) : ''}"></div>
      </div>
      <button class="btn prim blk" type="submit">Guardar</button>
      ${t ? '<button class="btn peligro blk" type="button" id="bBorrarTipo">Eliminar tipo</button>' : ''}
      <button class="btn blk" type="button" id="bVolver">‹ Volver</button>
    </form>`);
  const form = $('#fTipo', body);
  $('#bVolver', body).onclick = () => modalTipos();
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = Object.fromEntries(new FormData(form));
      if (f.recurrente && f.dia_semana === '') return toast('Un tipo que se repite necesita día', true);
      if (f.ensayo_dia !== '' && !f.ensayo_hora) return toast('Indica la hora del ensayo', true);
      const datos = {
        emoji: f.emoji.trim(), nombre: f.nombre.trim(), color: f.color, recurrente: !!f.recurrente,
        dia_semana: f.dia_semana === '' ? null : +f.dia_semana, hora: f.hora || null,
        ensayo_dia_semana: f.ensayo_dia === '' || f.ensayo_dia === 'mismo' ? null : +f.ensayo_dia,
        ensayo_hora: f.ensayo_dia === '' ? null : f.ensayo_hora,
      };
      const { error } = t
        ? await sb.from('tipos_evento').update(datos).eq('id', t.id)
        : await sb.from('tipos_evento').insert({ ...datos, orden: st.tipos.length + 1 });
      if (error) return fallo(error, 'Tipo');
      await cargarTipos(); toast('Guardado'); modalTipos();
    });
  };
  const bb = $('#bBorrarTipo', body);
  if (bb) bb.onclick = async () => {
    if (!confirm(`¿Eliminar el tipo "${t.nombre}"? Los días ya creados se conservan.`)) return;
    const { error } = await sb.from('tipos_evento').delete().eq('id', t.id);
    if (error) return fallo(error, 'Tipo');
    await cargarTipos(); toast('Eliminado'); modalTipos();
  };
}

// ---------- modal: asignar equipo ----------
async function modalAsignar(s, rolInicial) {
  const ind = await cargarIndisp(claveDia(new Date(s.fecha)), claveDia(new Date(s.fecha)));
  const nd = pid => ind.find(i => i.perfil_id === pid);
  let rol = ROLES[rolInicial] ? rolInicial : 'voz';
  let asig = [...(s.asignaciones || [])];
  const relevante = p => p.instrumento === rol;
  const conDirige = () => rol === 'voz' && !st.faltaV4;
  const pintar = () => {
    const gente = aprobados().sort((a, b) => relevante(b) - relevante(a) || a.nombre.localeCompare(b.nombre));
    const corte = gente.findIndex(p => !relevante(p));
    const body = abrirModal('Equipo del día', `
      <p class="ayuda" style="margin-top:0">${esc(s.titulo)} · ${fmtCorta(s.fecha)} ${fmtHora(s.fecha)}</p>
      <div class="segmentado">${Object.entries(ROLES).map(([k, v]) => {
        const n = asig.filter(a => a.rol === k).length;
        return `<button type="button" data-rol="${k}" class="${k === rol ? 'activo' : ''}">${esc(v)}${n ? ` (${n})` : ''}</button>`;
      }).join('')}</div>
      ${conDirige() ? '<p class="ayuda" style="margin-top:0">Marca 👑 a quien dirige este día (puede ser más de uno).</p>' : ''}
      <form id="fAsig"><div class="lista-check">
        ${gente.map((p, i) => {
          const actual = asig.find(a => a.perfil_id === p.id && a.rol === rol);
          const otros = asig.filter(a => a.perfil_id === p.id && a.rol !== rol).map(etiquetaRol).join(', ');
          return `${i === corte && corte > 0 ? '<div class="sep-check">Otros integrantes</div>' : ''}
            <div class="fila-check-wrap">
            <label class="check fila-check${nd(p.id) ? ' no-disp' : ''}"><input type="checkbox" name="p" value="${p.id}" ${actual ? 'checked' : ''}>
            <span><b>${esc(p.nombre)}</b> <small>${esc(INSTRUMENTOS[p.instrumento] || '')}${otros ? ' · ya en: ' + esc(otros) : ''}</small>${nd(p.id) ? `<small class="nd">🚫 No disponible${nd(p.id).motivo ? ': ' + esc(nd(p.id).motivo) : ''}</small>` : ''}</span>
            ${actual ? `<span title="${actual.estado}">${ICON_ESTADO[actual.estado]}</span>` : ''}</label>
            ${conDirige() ? `<label class="dirige-tg" title="Dirige"><input type="checkbox" name="d" value="${p.id}" ${actual?.dirige ? 'checked' : ''}><span>👑</span></label>` : ''}
            </div>`;
        }).join('')}
      </div>
      <button class="btn prim blk" type="submit">Guardar ${esc(ROLES[rol])}</button></form>
      <button class="btn blk" data-cerrar>Listo</button>`);
    body.querySelectorAll('[data-rol]').forEach(b => (b.onclick = () => { rol = b.dataset.rol; pintar(); }));
    const form = $('#fAsig', body);
    // Marcar 👑 implica estar asignado como Voz
    form.querySelectorAll('[name=d]').forEach(d => (d.onchange = () => {
      if (d.checked) form.querySelector(`[name=p][value="${d.value}"]`).checked = true;
    }));
    form.querySelectorAll('[name=p]').forEach(c => (c.onchange = () => {
      const d = form.querySelector(`[name=d][value="${c.value}"]`);
      if (d && !c.checked) d.checked = false;
    }));
    form.onsubmit = e => {
      e.preventDefault();
      ocupado(form.querySelector('[type=submit]'), async () => {
        const fd = new FormData(form);
        const quiero = new Set(fd.getAll('p'));
        const dirigen = new Set(fd.getAll('d'));
        const actuales = asig.filter(a => a.rol === rol);
        const quitar = actuales.filter(a => !quiero.has(a.perfil_id)).map(a => a.id);
        const agregar = [...quiero].filter(pid => !actuales.some(a => a.perfil_id === pid))
          .map(pid => ({ setlist_id: s.id, perfil_id: pid, rol, ...(conDirige() ? { dirige: dirigen.has(pid) } : {}) }));
        const cambiar = conDirige()
          ? actuales.filter(a => quiero.has(a.perfil_id) && !!a.dirige !== dirigen.has(a.perfil_id)) : [];
        if (quitar.length) { const { error } = await sb.from('asignaciones').delete().in('id', quitar); if (error) return fallo(error, 'Equipo'); }
        if (agregar.length) { const { error } = await sb.from('asignaciones').insert(agregar); if (error) return fallo(error, 'Equipo'); }
        for (const a of cambiar) {
          const { error } = await sb.from('asignaciones').update({ dirige: dirigen.has(a.perfil_id) }).eq('id', a.id);
          if (error) return fallo(error, 'Equipo');
        }
        const { data } = await sb.from('asignaciones').select(SEL_ASIG()).eq('setlist_id', s.id);
        asig = data || [];
        s.asignaciones = asig;
        toast(`${ROLES[rol]} guardado`);
        pintar();
      });
    };
  };
  pintar();
  dlg.addEventListener('close', () => rutear(), { once: true });
}

// ---------- vista: planificación del mes ----------
async function vistaPlan(ctx) {
  const mes = ctx.q.get('mes') || mesActual();
  cargando('Planificación', { atras: `#/agenda?mes=${mes}` });
  if (st.faltaV2) { app.innerHTML = encabezado('Planificación', { atras: '#/agenda' }) + avisoV2(); return; }
  const [ini, fin] = rangoMes(mes);
  const { data, error } = await conCache('plan:' + mes, sb.from('setlists').select(selDia() + ', setlist_items(id)')
    .gte('fecha', isoSinMs(ini)).lt('fecha', isoSinMs(fin)).order('fecha'));
  if (!ctx.vigente()) return;
  if (error) return fallo(error, 'Planificación');
  const ind = await cargarIndisp(claveDia(ini), claveDia(new Date(fin - 864e5)));
  if (!ctx.vigente()) return;
  const ndDia = s => { const k = claveDia(new Date(s.fecha)); return ind.filter(i => i.desde <= k && i.hasta >= k); };
  const usados = new Set(data.flatMap(s => s.asignaciones.map(a => a.rol)));
  const cols = Object.keys(ROLES).filter(r => r !== 'otro' || usados.has('otro'));
  const conteo = new Map();
  data.forEach(s => new Set(s.asignaciones.filter(a => a.estado !== 'rechazado').map(a => a.perfil_id)).forEach(id => conteo.set(id, (conteo.get(id) || 0) + 1)));
  const sinAsignar = aprobados().filter(p => !conteo.has(p.id));

  app.innerHTML = encabezado('Planificación', { atras: `#/agenda?mes=${mes}`, sub: nombreMes(mes) }) + `
    <div class="cal-head" style="margin-bottom:10px">
      <a class="btn-ico" href="#/plan?mes=${moverMes(mes, -1)}" aria-label="Mes anterior">‹</a>
      <b>${esc(nombreMes(mes))}</b>
      <a class="btn-ico" href="#/plan?mes=${moverMes(mes, 1)}" aria-label="Mes siguiente">›</a>
    </div>
    ${data.length ? `<div class="fila" style="margin-bottom:10px">
      <button class="btn sm" data-acc="xls-exp">⬇️ Exportar Excel</button>
      ${esAdmin() ? '<button class="btn sm" data-acc="xls-imp">⬆️ Importar Excel</button><input type="file" id="xlsArchivo" accept=".xlsx,.xls,.csv" hidden>' : ''}
    </div>` : ''}
    ${data.length ? `<div class="tabla-wrap"><table class="plan">
      <thead><tr><th>Día</th>${cols.map(c => `<th>${esc(ROLES[c])}</th>`).join('')}<th>🎵</th></tr></thead>
      <tbody>${data.map(s => {
        const t = tipoDe(s);
        return `<tr><th style="border-left:3px solid ${esc(t.color)}"><a href="#/dia/${s.id}">${esc(t.emoji)} ${fmtCorta(s.fecha)}</a><small>${fmtHora(s.fecha)}</small>${ndDia(s).length ? `<small class="nd" title="No disponibles">🚫 ${ndDia(s).map(i => esc(nombreCorto(i.perfil_id))).join(', ')}</small>` : ''}</th>
          ${cols.map(c => {
            const as = s.asignaciones.filter(a => a.rol === c);
            return `<td class="${esAdmin() ? 'editable' : ''}" data-acc="celda" data-id="${s.id}" data-rol="${c}">${as.map(a =>
              `<span class="p ${a.estado}${ndDia(s).some(i => i.perfil_id === a.perfil_id) ? ' choque' : ''}" title="${TXT_ESTADO[a.estado] || a.estado}${a.dirige ? ' · dirige' : ''}">${a.dirige ? '👑 ' : ''}${esc(nombreCorto(a.perfil_id))}</span>`).join('') || '<span class="vacio-c">—</span>'}</td>`;
          }).join('')}
          <td>${s.setlist_items.length || '—'}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="ayuda">👑 dirige · ✅ confirmado · ⏳ <span class="p pendiente" style="padding:0 4px">sin responder</span> · <span class="p por_confirmar" style="padding:0 4px">🤔 por confirmar</span> · <span class="p rechazado" style="padding:0 4px">no puede</span>${esAdmin() ? ' · Toca una celda para asignar.' : ''}</p>`
      : `<div class="vacio"><span class="grande">📋</span>No hay días este mes.${esAdmin() ? '<br>Usa <b>Generar mes</b> en la Agenda.' : ''}</div>`}
    ${data.length ? `<div class="seccion-t">Participación del mes</div>
      <div class="card" style="font-size:14px">${[...conteo.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${esc(nombreDe(id))} <b>${n}</b>`).join(' · ') || 'Nadie asignado aún.'}
      ${sinAsignar.length ? `<p class="ayuda" style="margin-bottom:0">Sin asignar: ${sinAsignar.map(p => esc(p.nombre)).join(', ')}</p>` : ''}</div>` : ''}`;

  const archivo = $('#xlsArchivo');
  if (archivo) archivo.onchange = () => { const f = archivo.files[0]; archivo.value = ''; if (f) importarExcel(f, mes, data); };
  app.onclick = e => {
    const x = e.target.closest('[data-acc^=xls]');
    if (x) {
      if (x.dataset.acc === 'xls-exp') ocupado(x, () => exportarExcel(mes, data));
      else archivo?.click();
      return;
    }
    const el = e.target.closest('[data-acc=celda]');
    if (!el || !esAdmin() || e.target.closest('a')) return;
    const s = data.find(x => x.id === el.dataset.id);
    modalAsignar(s, el.dataset.rol);
  };
}

// ---------- Excel de asignaciones (una fila por día, una columna por rol) ----------
let _xlsx = null;
function cargarXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (_xlsx ??= new Promise((ok, mal) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    sc.onload = () => ok(window.XLSX);
    sc.onerror = () => { _xlsx = null; mal(new Error('No se pudo cargar el lector de Excel (¿sin internet?)')); };
    document.head.appendChild(sc);
  }));
}
const COLS_EXCEL = () => [['dirige', 'Dirige'], ...Object.entries(ROLES)];
const dosDig = n => String(n).padStart(2, '0');
const fechaExcel = iso => { const d = new Date(iso); return `${dosDig(d.getDate())}/${dosDig(d.getMonth() + 1)}/${d.getFullYear()}`; };
const horaExcel = iso => { const d = new Date(iso); return `${dosDig(d.getHours())}:${dosDig(d.getMinutes())}`; };

async function exportarExcel(mes, data) {
  let X;
  try { X = await cargarXLSX(); } catch (e) { return toast(e.message, true); }
  const cols = COLS_EXCEL();
  const filas = data.map(s => {
    const asig = (s.asignaciones || []).filter(a => a.estado !== 'rechazado');
    const fila = { Fecha: fechaExcel(s.fecha), Hora: horaExcel(s.fecha), 'Día': `${tipoDe(s).nombre || ''}${s.titulo && s.titulo !== tipoDe(s).nombre ? ' · ' + s.titulo : ''}` };
    cols.forEach(([k, et]) => {
      const as = k === 'dirige' ? asig.filter(a => a.rol === 'voz' && a.dirige)
        : k === 'voz' ? asig.filter(a => a.rol === 'voz' && !a.dirige) : asig.filter(a => a.rol === k);
      fila[et] = as.map(a => nombreDe(a.perfil_id)).join(', ');
    });
    fila.ID = s.id;
    return fila;
  });
  const wb = X.utils.book_new();
  const ws = X.utils.json_to_sheet(filas, { header: ['Fecha', 'Hora', 'Día', ...cols.map(c => c[1]), 'ID'] });
  ws['!cols'] = [{ wch: 11 }, { wch: 6 }, { wch: 22 }, ...cols.map(() => ({ wch: 22 })), { wch: 10, hidden: true }];
  X.utils.book_append_sheet(wb, ws, 'Asignaciones');
  const gente = aprobados().sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map(p => ({ Nombre: p.nombre, Instrumento: INSTRUMENTOS[p.instrumento] || '' }));
  const ws2 = X.utils.json_to_sheet(gente);
  ws2['!cols'] = [{ wch: 28 }, { wch: 20 }];
  X.utils.book_append_sheet(wb, ws2, 'Integrantes');
  X.writeFile(wb, `asignaciones_${mes}.xlsx`);
  toast('Excel descargado');
}

// Convierte la celda "Fecha" (texto dd/mm/aaaa, fecha de Excel o número) a aaaa-mm-dd
function leerFechaExcel(v, X) {
  if (v instanceof Date) return claveDia(v);
  if (typeof v === 'number') { const d = X.SSF.parse_date_code(v); return d ? `${d.y}-${dosDig(d.m)}-${dosDig(d.d)}` : null; }
  const t = String(v || '').trim();
  let m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(t);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${dosDig(m[2])}-${dosDig(m[1])}`;
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  return m ? `${m[1]}-${dosDig(m[2])}-${dosDig(m[3])}` : null;
}

async function importarExcel(file, mes, data) {
  let X;
  try { X = await cargarXLSX(); } catch (e) { return toast(e.message, true); }
  let filas;
  try {
    const wb = X.read(await file.arrayBuffer());   // sin cellDates: evita corrimientos por zona horaria
    filas = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
  } catch { return toast('No pude leer el archivo. ¿Es un Excel válido?', true); }
  if (!filas.length) return toast('El archivo no tiene filas', true);

  // Columnas → roles
  const porEtiqueta = new Map(COLS_EXCEL().flatMap(([k, et]) => [[normalizar(et), k], [normalizar(k), k]]));
  porEtiqueta.set('voz principal', 'voz'); porEtiqueta.set('coros', 'voz'); porEtiqueta.set('percusion', 'percusion');
  const encabezados = Object.keys(filas[0]);
  const colRol = encabezados.map(h => [h, porEtiqueta.get(normalizar(h).trim())]).filter(([, k]) => k);
  if (!colRol.length) return toast('No encontré columnas de roles (Dirige, Voz, Piano…). Usa el Excel exportado como plantilla.', true);
  const colFecha = encabezados.find(h => normalizar(h).trim() === 'fecha');
  const colHora = encabezados.find(h => normalizar(h).trim() === 'hora');
  const colId = encabezados.find(h => normalizar(h).trim() === 'id');

  // Nombres → integrantes (nombre completo, "Nombre A.", o solo el nombre si es único)
  const idx = new Map(), primeros = new Map();
  aprobados().forEach(p => {
    idx.set(normalizar(p.nombre).trim(), p.id);
    idx.set(normalizar(nombreCorto(p.id)).trim(), p.id);
    const pri = normalizar(p.nombre).trim().split(/\s+/)[0];
    primeros.set(pri, primeros.has(pri) ? null : p.id);
  });
  const buscar = n => { const k = normalizar(n).replace(/\s+/g, ' ').trim(); return idx.get(k) || primeros.get(k) || null; };

  const plan = [], noDias = [], noNombres = new Set();
  const usados = new Set();
  filas.forEach((f, n) => {
    let s = colId && data.find(x => x.id === String(f[colId]).trim());
    if (!s && colFecha) {
      const dia = leerFechaExcel(f[colFecha], X);
      const cand = data.filter(x => claveDia(new Date(x.fecha)) === dia);
      const hv = colHora ? f[colHora] : '';
      const hora = typeof hv === 'number'   // Excel guarda la hora como fracción del día
        ? `${dosDig(Math.floor(((hv % 1) * 1440 + 0.5) / 60))}:${dosDig(Math.round((hv % 1) * 1440) % 60)}`
        : String(hv).trim().padStart(5, '0');
      s = cand.length > 1 && hora ? cand.find(x => horaExcel(x.fecha) === hora) || cand[0] : cand[0];
    }
    const vacia = colRol.every(([h]) => !String(f[h]).trim());
    if (!s) { if (!vacia || (colFecha && String(f[colFecha]).trim())) noDias.push((colFecha && (leerFechaExcel(f[colFecha], X) || String(f[colFecha]))) || `fila ${n + 2}`); return; }
    if (usados.has(s.id)) return;
    usados.add(s.id);
    const quiero = new Map();   // perfil|rol -> dirige
    colRol.forEach(([h, k]) => String(f[h]).split(/[,;\n\/]|\s+y\s+/i).map(x => x.trim()).filter(Boolean).forEach(nom => {
      const pid = buscar(nom);
      if (!pid) { noNombres.add(nom); return; }
      const rol = k === 'dirige' ? 'voz' : k;
      const clave = pid + '|' + rol;
      quiero.set(clave, (quiero.get(clave) || false) || k === 'dirige');
    }));
    plan.push({ s, quiero });
  });
  if (!plan.length) return toast('Ninguna fila coincide con los días de este mes', true);

  const total = plan.reduce((t, p) => t + p.quiero.size, 0);
  const body = abrirModal('Importar asignaciones', `
    <p style="margin-top:0">Se van a <b>reemplazar</b> las asignaciones de <b>${plan.length}</b> día(s) de ${esc(nombreMes(mes))} con <b>${total}</b> asignación(es) del archivo.</p>
    <p class="ayuda">Quien ya estaba asignado al mismo rol conserva su confirmación ✅/❌.</p>
    ${noNombres.size ? `<div class="card" style="border-color:var(--peligro);font-size:14px">⚠️ No reconozco estos nombres (se ignoran): <b>${[...noNombres].map(esc).join(', ')}</b><br><small>Escríbelos como en la hoja <i>Integrantes</i>.</small></div>` : ''}
    ${noDias.length ? `<div class="card" style="border-color:var(--peligro);font-size:14px">⚠️ Filas sin día en la agenda (se ignoran): ${noDias.map(esc).join(', ')}</div>` : ''}
    ${data.length > plan.length ? `<p class="ayuda">${data.length - plan.length} día(s) del mes no están en el archivo y quedan igual.</p>` : ''}
    <button class="btn prim blk" id="bImp">Reemplazar asignaciones</button>
    <button class="btn blk" data-cerrar>Cancelar</button>`);
  $('#bImp', body).onclick = e => ocupado(e.currentTarget, async () => {
    const borrar = [], insertar = [], cambiar = [];
    plan.forEach(({ s, quiero }) => {
      const actuales = s.asignaciones || [];
      actuales.forEach(a => {
        const clave = a.perfil_id + '|' + a.rol;
        if (!quiero.has(clave)) borrar.push(a.id);
        else if (!st.faltaV4 && !!a.dirige !== quiero.get(clave)) cambiar.push({ id: a.id, dirige: quiero.get(clave) });
      });
      quiero.forEach((dirige, clave) => {
        const [perfil_id, rol] = clave.split('|');
        if (!actuales.some(a => a.perfil_id === perfil_id && a.rol === rol))
          insertar.push({ setlist_id: s.id, perfil_id, rol, ...(st.faltaV4 ? {} : { dirige }) });
      });
    });
    for (let i = 0; i < borrar.length; i += 100) {
      const { error } = await sb.from('asignaciones').delete().in('id', borrar.slice(i, i + 100));
      if (error) return fallo(error, 'Importar');
    }
    if (insertar.length) { const { error } = await sb.from('asignaciones').insert(insertar); if (error) return fallo(error, 'Importar'); }
    for (const c of cambiar) { const { error } = await sb.from('asignaciones').update({ dirige: c.dirige }).eq('id', c.id); if (error) return fallo(error, 'Importar'); }
    cerrarModal();
    toast(`Importado: ${insertar.length} nuevas, ${borrar.length} quitadas`);
    rutear();
  });
}

// ---------- vista: un día ----------
async function vistaDia(ctx) {
  cargando('Día', { atras: '#/agenda' });
  const [rs, ri, rv] = await Promise.all([
    conCache('dia:' + ctx.id, sb.from('setlists').select(st.faltaV2 ? '*' : selDia()).eq('id', ctx.id).maybeSingle()),
    conCache('items:' + ctx.id, sb.from('setlist_items').select(selItems()).eq('setlist_id', ctx.id).order('orden')),
    st.faltaV2 ? Promise.resolve({ data: null }) : sb.from('en_vivo').select('*').eq('setlist_id', ctx.id).maybeSingle(),
  ]);
  if (!ctx.vigente()) return;
  if (rs.error || ri.error) return fallo(rs.error || ri.error, 'Día');
  const s = rs.data;
  if (!s) { app.innerHTML = encabezado('Día', { atras: '#/agenda' }) + '<div class="vacio">Este día ya no existe.</div>'; return; }
  s.asignaciones ??= [];
  const items = ri.data.filter(i => i.cancion);
  const vivo = rv.data?.activo ? rv.data : null;
  const t = tipoDe(s);
  const mios = misRoles(s);
  const estadoMio = mios.every(a => a.estado === mios[0]?.estado) ? mios[0]?.estado : '';
  const personas = est => new Set(s.asignaciones.filter(a => a.estado === est).map(a => a.perfil_id)).size;
  const nSinResp = personas('pendiente'), nPorConf = personas('por_confirmar');
  const aRecordar = new Set(s.asignaciones.filter(a => SIN_CONFIRMAR.includes(a.estado) && a.perfil_id !== st.uid).map(a => a.perfil_id)).size;
  const resumenConf = esAdmin() && s.asignaciones.length && !st.faltaV2 ? `<div class="card resumen-conf">
      <div class="info">${nSinResp || nPorConf
        ? `${nSinResp ? `⏳ <b>${nSinResp}</b> sin responder` : ''}${nSinResp && nPorConf ? ' · ' : ''}${nPorConf ? `🤔 <b>${nPorConf}</b> por confirmar` : ''}`
        : '✅ Todo el equipo respondió'}</div>
      ${aRecordar && !st.faltaV7 ? `<button class="btn sm" data-acc="recordar">🔔 Recordar (${aRecordar})</button>` : ''}
    </div>` : '';

  const grupo = (titulo, roles) => {
    const as = s.asignaciones.filter(a => roles.includes(a.rol)).sort(ordenAsig);
    return `<div class="seccion-t">${titulo}</div>` + (as.length
      ? `<div class="card equipo-dia">${as.map(a => `<div class="eq-fila ${a.estado}">
          <span class="eq-rol">${esc(etiquetaRol(a))}</span><b>${esc(nombreDe(a.perfil_id))}</b><span title="${TXT_ESTADO[a.estado] || a.estado}">${ICON_ESTADO[a.estado] || ''}</span>${esAdmin() && SIN_CONFIRMAR.includes(a.estado) && a.perfil_id !== st.uid && !st.faltaV7 ? `<button class="eq-rec" data-acc="recordar-uno" data-perfil="${a.perfil_id}" title="Enviar recordatorio" aria-label="Enviar recordatorio">🔔</button>` : ''}</div>`).join('')}</div>`
      : '<p class="ayuda">Sin asignar.</p>');
  };

  const derecha = esAdmin() ? `<button class="btn-ico" data-acc="editar" aria-label="Editar">✏️</button>` : '';
  app.innerHTML = encabezado(s.titulo, { atras: '#/agenda', sub: `${t.emoji} ${t.nombre}`, derecha }) + `
    ${st.faltaV2 ? avisoV2() : ''}
    <div class="card" style="border-left:3px solid ${esc(t.color)}">
      <div style="font-weight:700;text-transform:capitalize">📅 ${esc(fmtFechaLarga(s.fecha))} · ${esc(fmtHora(s.fecha))}</div>
      ${s.ensayo_fecha ? `<div style="margin-top:4px">🎹 Ensayo: <span style="text-transform:capitalize">${esc(fmtFechaLarga(s.ensayo_fecha))}</span> · ${esc(fmtHora(s.ensayo_fecha))}</div>` : ''}
      ${s.lugar ? `<div style="margin-top:4px;color:var(--texto-2)">📍 ${esc(s.lugar)}</div>` : ''}
      ${s.notas ? `<p class="post-texto" style="margin-top:10px">${esc(s.notas)}</p>` : ''}
    </div>
    ${mios.length ? `<div class="card confirmar">
      <div><b>🙋 Te toca:</b> ${mios.map(a => esc(etiquetaRol(a))).join(', ')}</div>
      <div class="fila" style="margin-top:10px">${botonesEstado('conf-mio', '', estadoMio)}</div></div>` : ''}
    ${vivo ? `<div class="card vivo-banner"><span class="punto-vivo"></span><div class="info"><b>En vivo ahora</b><small>Canción ${vivo.indice + 1} de ${items.length}</small></div>
        <button class="btn prim sm" data-acc="vivo-unirse">Unirme</button>
        ${esAdmin() ? '<button class="btn sm" data-acc="vivo-fin">Terminar</button>' : ''}</div>`
      : esAdmin() && items.length && !st.faltaV2 ? `<button class="btn blk" data-acc="vivo-iniciar" style="margin:0 0 12px">🔴 Iniciar en vivo</button>` : ''}
    ${resumenConf}
    ${st.faltaV2 ? '' : `${grupo('🎤 Cantores', ROLES_CANTO)}
      ${grupo('🎸 Instrumentistas', Object.keys(ROLES).filter(r => !ROLES_CANTO.includes(r)))}
      ${esAdmin() ? '<button class="btn sm" data-acc="asignar">👥 Asignar equipo</button>' : ''}`}
    <div class="seccion-t" style="display:flex;justify-content:space-between;align-items:center">
      <span>🎵 Repertorio (${items.length})</span>
      ${esAdmin() && items.length > 1 && hayRitmo(items) ? '<button class="btn sm" data-acc="ord-ritmo" style="margin:0">⚡→🕊️ Ordenar por ritmo</button>' : ''}
    </div>
    ${esAdmin() && items.length > 1 ? '<p class="ayuda" style="margin:-4px 0 8px">Arrastra ⠿ para cambiar el orden.</p>' : ''}
    <div class="lista" id="listaRep">
      ${items.map((it, i) => `
      <div class="item set-item ${vivo && vivo.indice === i ? 'en-vivo' : ''}" data-acc="abrir" data-i="${i}" data-id="${it.id}">
        ${esAdmin() && items.length > 1 ? '<span class="arrastre" data-acc="drag" aria-label="Arrastrar para ordenar">⠿</span>' : ''}
        <span class="num">${i + 1}</span>
        <div class="info"><b>${ICON_RITMO[ritmoDe(it)] ? ICON_RITMO[ritmoDe(it)] + ' ' : ''}${esc(it.cancion.titulo)}</b><small>${it.cantante_id ? '🎤 ' + esc(nombreDe(it.cantante_id)) : 'Sin cantante asignado'}${it.notas ? ' · ' + esc(it.notas) : ''}</small></div>
        <span class="tono-pill">${esc(tonoTxt(it.tono || it.cancion.tono_original))}</span>
        ${esAdmin() ? `<div class="acc-item">
          <button data-acc="item" data-i="${i}" aria-label="Editar">✏️</button>
          <button data-acc="quitar" data-i="${i}" aria-label="Quitar del día">🗑️</button>
        </div>` : ''}
      </div>`).join('') || `<div class="vacio"><span class="grande">🎶</span>Todavía no hay canciones asignadas.</div>`}
    </div>
    ${esAdmin() ? `<button class="btn prim blk" data-acc="agregar">+ Agregar canción</button>` : ''}
    <div class="fila" style="margin-top:12px">
      ${esAdmin() && !st.faltaV2 ? '<button class="btn" data-acc="publicar">📣 Publicar en el muro</button>' : ''}
      <button class="btn" data-acc="compartir">📤 WhatsApp</button>
    </div>
    ${htmlChat()}
    ${esAdmin() ? `<button class="btn peligro blk" data-acc="borrar" style="margin-top:28px">Eliminar día</button>` : ''}`;

  // Si alguien inicia/termina el en vivo, refrescar
  if (!st.faltaV2) {
    const canal = sb.channel('dia-' + s.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'en_vivo', filter: `setlist_id=eq.${s.id}` }, () => ctx.vigente() && rutear())
      .subscribe();
    st.limpiar.push(() => sb.removeChannel(canal));
  }

  if (!st.faltaV2 && !st.faltaV4) iniciarChat(s, ctx);

  if (esAdmin() && items.length > 1) {
    activarArrastre($('#listaRep'), async ids => {
      const cambios = ids.map((id, k) => ({ id, k })).filter(({ id, k }) => items.find(x => x.id === id).orden !== k);
      const res = await Promise.all(cambios.map(({ id, k }) => sb.from('setlist_items').update({ orden: k }).eq('id', id)));
      const er = res.find(r => r.error);
      if (er) fallo(er.error, 'Orden'); else toast('Orden guardado');
      // Si hay un en vivo activo, que siga en la misma canción aunque cambie su posición
      if (!er && vivo) {
        const nuevo = ids.indexOf(items[vivo.indice]?.id);
        if (nuevo >= 0 && nuevo !== vivo.indice) await sb.from('en_vivo').update({ indice: nuevo }).eq('setlist_id', s.id);
      }
      if (ctx.vigente()) rutear();
    });
  }

  const irCancion = (i, vivoParam = false) => {
    const it = items[i];
    location.hash = `#/cancion/${it.cancion_id}?set=${s.id}&i=${i}${it.tono ? '&tono=' + encodeURIComponent(it.tono) : ''}${vivoParam ? '&vivo=1' : ''}`;
  };

  app.onclick = async e => {
    const el = e.target.closest('[data-acc]');
    if (!el) return;
    const acc = el.dataset.acc, i = +el.dataset.i, it = items[i];
    try {
      if (acc === 'drag') return;
      if (acc === 'abrir') irCancion(i, !!vivo);
      else if (acc === 'quitar') {
        if (!confirm(`¿Quitar "${it.cancion.titulo}" del repertorio de este día?\n(La canción sigue en el módulo Canciones.)`)) return;
        const { error } = await sb.from('setlist_items').delete().eq('id', it.id);
        if (error) throw error;
        toast('Quitada del repertorio'); rutear();
      }
      else if (acc === 'ord-ritmo') {
        if (await ordenarPorRitmo(s.id)) { toast('Ordenado: rápidas → lentas'); rutear(); }
        else toast('Ya estaba ordenado');
      }
      else if (acc === 'item') modalItem(s, items, it);
      else if (acc === 'agregar') modalItem(s, items, null);
      else if (acc === 'editar') modalDia(s);
      else if (acc === 'asignar') modalAsignar(s);
      else if (acc === 'compartir') compartirDia(s, items);
      else if (acc === 'publicar') modalPublicarDia(s);
      else if (acc === 'conf-mio') {
        const { error } = await sb.from('asignaciones').update({ estado: el.dataset.estado }).in('id', mios.map(a => a.id));
        if (error) { if (avisoV9(error)) return; throw error; }
        toast(TOAST_ESTADO[el.dataset.estado]); rutear();
      }
      else if (acc === 'recordar' || acc === 'recordar-uno') {
        const uno = acc === 'recordar-uno' ? el.dataset.perfil : null;
        const quien = uno ? nombreDe(uno) : `${aRecordar} persona${aRecordar === 1 ? '' : 's'} sin confirmar`;
        if (!confirm(`¿Enviar recordatorio a ${quien}?\nLes llega una notificación y queda escrito en el chat del día.`)) return;
        el.disabled = true;
        const { data, error } = await sb.rpc('recordar_pendientes', { p_setlist: s.id, p_perfil: uno });
        el.disabled = false;
        if (error) { if (avisoV9(error)) return; throw error; }
        toast(data ? `Recordatorio enviado 🔔 (${data})` : 'No hay nadie pendiente');
        rutear();
      }
      else if (acc === 'vivo-iniciar') {
        const { error } = await sb.from('en_vivo').upsert({
          setlist_id: s.id, indice: 0, cancion_id: items[0].cancion_id, tono: items[0].tono, activo: true, actualizado_por: st.uid,
        }, { onConflict: 'setlist_id' });
        if (error) throw error;
        st.seguirVivo = true; irCancion(0, true);
      }
      else if (acc === 'vivo-unirse') { st.seguirVivo = true; irCancion(Math.min(vivo.indice, items.length - 1), true); }
      else if (acc === 'vivo-fin') {
        const { error } = await sb.from('en_vivo').update({ activo: false }).eq('setlist_id', s.id);
        if (error) throw error;
        toast('En vivo terminado'); rutear();
      }
      else if (acc === 'borrar') {
        if (!confirm(`¿Eliminar "${s.titulo}" con su equipo y repertorio?`)) return;
        const { error } = await sb.from('setlists').delete().eq('id', s.id);
        if (error) throw error;
        toast('Eliminado'); location.hash = '#/agenda';
      }
    } catch (err) { fallo(err, 'Día'); }
  };
}

// ---------- chat por evento ----------
function htmlChat() {
  if (st.faltaV2) return '';
  if (st.faltaV4) return esAdmin()
    ? '<div class="card" style="border-color:var(--peligro);margin-top:16px">⚠️ Para activar el chat ejecuta <b>supabase/004_voz_dirige_chat.sql</b> en Supabase → SQL Editor.</div>' : '';
  return `<div class="seccion-t">💬 Chat del día</div>
    <div class="card chat">
      <div class="chat-lista" id="chatLista"><div class="chat-vacio">Cargando…</div></div>
      <form class="chat-form" id="fChat">
        <div class="men-sug" id="menSug" hidden></div>
        <button type="button" class="btn-ico men-at" data-at aria-label="Mencionar a alguien">@</button>
        <textarea name="texto" maxlength="1000" rows="1" placeholder="Escribe… usa @ para mencionar" aria-label="Mensaje"></textarea>
        <button class="btn prim" type="submit">Enviar</button>
      </form>
    </div>`;
}

async function iniciarChat(s, ctx) {
  const lista = $('#chatLista'), form = $('#fChat');
  if (!lista || !form) return;
  let msgs = [];
  const fmtMsg = iso => {
    const d = new Date(iso);
    return claveDia(d) === claveDia(new Date()) ? fmtHora(d) : `${fmtCorta(d)} ${fmtHora(d)}`;
  };
  const pintar = (bajar = true) => {
    lista.innerHTML = msgs.length ? msgs.map(m => `
      <div class="chat-msg ${m.autor_id === st.uid ? 'mio' : ''}${m._nuevo ? ' nuevo' : ''}${m.autor_id !== st.uid && mencionaA(m.texto, s) ? ' me-nombra' : ''}" data-id="${m.id}">
        ${m.autor_id === st.uid ? '' : `<b>${esc(nombreDe(m.autor_id))}</b>`}
        <p>${textoConMenciones(m.texto, s)}<small>${esc(fmtMsg(m.created_at))}</small>${m.autor_id === st.uid || esAdmin()
          ? `<button class="x" data-msg="${m.id}" aria-label="Borrar mensaje">✕</button>` : ''}</p>
      </div>`).join('') : '<div class="chat-vacio">Sin mensajes. ¡Escribe el primero!</div>';
    if (bajar) lista.scrollTop = lista.scrollHeight;
    msgs.forEach(m => delete m._nuevo);
  };
  const r = await conCache('chat:' + s.id, sb.from('mensajes_evento').select('*').eq('setlist_id', s.id).order('created_at').limit(300));
  if (!ctx.vigente()) return;
  if (r.error) { lista.innerHTML = '<div class="chat-vacio">No se pudo cargar el chat.</div>'; return; }
  msgs = r.data || [];
  pintar();
  const irA = ctx.q.get('men');
  const objetivo = irA && lista.querySelector(`[data-id="${CSS.escape(irA)}"]`);
  if (objetivo) {
    lista.scrollTop = objetivo.offsetTop - 40;
    objetivo.classList.add('destello');
    setTimeout(() => window.scrollTo({ top: lista.getBoundingClientRect().top + scrollY - 140, behavior: 'smooth' }), 150);
  }
  marcarLeidas(s.id);

  const canal = sb.channel('chat-' + s.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes_evento', filter: `setlist_id=eq.${s.id}` }, ({ new: m }) => {
      if (!ctx.vigente() || msgs.some(x => x.id === m.id)) return;
      const abajo = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 60;
      m._nuevo = true; msgs.push(m); pintar(abajo || m.autor_id === st.uid);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'mensajes_evento' }, ({ old }) => {
      if (!ctx.vigente() || !msgs.some(x => x.id === old.id)) return;
      msgs = msgs.filter(x => x.id !== old.id); pintar(false);
    })
    .subscribe();
  st.limpiar.push(() => sb.removeChannel(canal));

  lista.onclick = async e => {
    const b = e.target.closest('[data-msg]');
    if (!b || !confirm('¿Borrar este mensaje?')) return;
    const { error } = await sb.from('mensajes_evento').delete().eq('id', b.dataset.msg);
    if (error) return fallo(error, 'Chat');
    msgs = msgs.filter(x => x.id !== b.dataset.msg); pintar(false);
  };
  const ta = form.texto;
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; };
  // ----- menciones: @ abre la lista de personas y grupos -----
  const sug = $('#menSug');
  const menMapa = new Map();   // "@Nombre" visible -> token "@[Nombre](id)"
  let opciones = [], sel = 0, ini = -1;
  const delDia = new Set((s.asignaciones || []).map(a => a.perfil_id));
  const limpioN = n => String(n || '').replace(/[[\]()@]/g, '').trim();
  const candidatos = q => {
    const nq = normalizar(q);
    const grupos = Object.entries(GRUPOS_MEN).map(([k, v]) => ({ vis: k, sub: v, token: `@[${k}](grupo)`, ico: '👥' }));
    const gente = aprobados().filter(p => p.id !== st.uid && limpioN(p.nombre))
      .sort((a, b) => delDia.has(b.id) - delDia.has(a.id) || a.nombre.localeCompare(b.nombre))
      .map(p => ({ vis: limpioN(p.nombre), sub: delDia.has(p.id) ? 'Sirve este día' : INSTRUMENTOS[p.instrumento] || '', token: `@[${limpioN(p.nombre)}](${p.id})`, ico: iniciales(p.nombre) }));
    return [...grupos, ...gente].filter(c => !nq || normalizar(c.vis).includes(nq)).slice(0, 7);
  };
  const cerrarSug = () => { sug.hidden = true; ini = -1; };
  const pintarSug = () => {
    sug.innerHTML = opciones.map((o, i) => `<button type="button" class="men-op ${i === sel ? 'activo' : ''}" data-op="${i}">
      <span class="avatar sm">${esc(o.ico)}</span><span><b>@${esc(o.vis)}</b><small>${esc(o.sub)}</small></span></button>`).join('');
    sug.hidden = !opciones.length;
  };
  const detectar = () => {
    const pos = ta.selectionStart, m = /(^|\s)@([^\s@]{0,24})$/.exec(ta.value.slice(0, pos));
    if (!m) return cerrarSug();
    ini = pos - m[2].length - 1;
    opciones = candidatos(m[2]); sel = 0; pintarSug();
  };
  const elegir = i => {
    const o = opciones[i];
    if (!o || ini < 0) return;
    const vis = '@' + o.vis + ' ';
    ta.value = ta.value.slice(0, ini) + vis + ta.value.slice(ta.selectionStart);
    menMapa.set('@' + o.vis, o.token);
    const c = ini + vis.length;
    cerrarSug(); ta.focus(); ta.setSelectionRange(c, c); ajustarAlto();
  };
  const conTokens = t => [...menMapa.keys()].sort((a, b) => b.length - a.length).reduce((acc, k) => acc.split(k).join(menMapa.get(k)), t);
  const ajustarAlto = ta.oninput;
  ta.oninput = () => { ajustarAlto(); detectar(); };
  ta.onblur = () => setTimeout(cerrarSug, 150);
  sug.onpointerdown = e => e.preventDefault();
  sug.onclick = e => { const b = e.target.closest('[data-op]'); if (b) elegir(+b.dataset.op); };
  form.querySelector('[data-at]').onclick = () => {
    const p = ta.selectionStart ?? ta.value.length;
    const pre = p && !/\s/.test(ta.value[p - 1]) ? ' @' : '@';
    ta.value = ta.value.slice(0, p) + pre + ta.value.slice(p);
    ta.focus(); const c = p + pre.length; ta.setSelectionRange(c, c); detectar();
  };
  ta.onkeydown = e => {
    if (!sug.hidden && opciones.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + opciones.length) % opciones.length; return pintarSug(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return elegir(sel); }
      if (e.key === 'Escape') { e.preventDefault(); return cerrarSug(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); form.requestSubmit(); }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const texto = conTokens(ta.value.trim());
    if (!texto) return;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const { data, error } = await sb.from('mensajes_evento').insert({ setlist_id: s.id, texto, autor_id: st.uid }).select().single();
    btn.disabled = false;
    if (error) return fallo(error, 'Chat');
    ta.value = ''; menMapa.clear(); ta.oninput();
    if (!msgs.some(x => x.id === data.id)) { msgs.push(data); pintar(); }
  };
}

function modalPublicarDia(s) {
  const body = abrirModal('Publicar en el muro', `
    <form id="fPub">
      <p class="ayuda" style="margin-top:0">Se publica el resumen de <b>${esc(s.titulo)}</b>: fecha, ensayo, equipo y canciones. Si después cambias algo, la publicación se actualiza sola.</p>
      <label>Mensaje (opcional)</label>
      <textarea name="contenido" maxlength="1000" placeholder="Ej: ¡Bendiciones equipo! Repasen las canciones 🙌"></textarea>
      <label class="check"><input type="checkbox" name="fijada" checked> 📌 Fijar arriba del muro</label>
      <button class="btn prim blk" type="submit">Publicar</button>
    </form>`);
  const form = $('#fPub', body);
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = Object.fromEntries(new FormData(form));
      const { error } = await sb.from('publicaciones').insert({
        tipo: 'programa', titulo: s.titulo, contenido: f.contenido.trim() || null, setlist_id: s.id, fijada: !!f.fijada, autor_id: st.uid,
      });
      if (error) return fallo(error, 'Publicar');
      cerrarModal(); toast('Publicado en el muro'); location.hash = '#/muro';
    });
  };
}

async function modalItem(s, items, it) {
  const hist = await cargarHistorial();
  const [rc, rt] = await Promise.all([
    sb.from('canciones').select(st.faltaV6 ? 'id, titulo, artista, tono_original, letra' : 'id, titulo, artista, tono_original, ritmo, letra').order('titulo'),
    sb.from('tonos_cantante').select('cancion_id, cantante_id, tono'),
  ]);
  if (rc.error || rt.error) return fallo(rc.error || rt.error, 'Canciones');
  const canciones = rc.data;
  if (!canciones.length) return toast('Primero crea canciones en la pestaña Canciones', true);
  const tonoGuardado = (cid, pid) => rt.data.find(t => t.cancion_id === cid && t.cantante_id === pid)?.tono;
  // Cantantes del día primero
  const delDia = new Set((s.asignaciones || []).filter(a => ROLES_CANTO.includes(a.rol)).map(a => a.perfil_id));
  const lista = cantantes().sort((a, b) => delDia.has(b.id) - delDia.has(a.id));
  const body = abrirModal(it ? 'Editar canción del repertorio' : 'Agregar canción', `
    <form id="fItem">
      <label>Canción</label>
      <div id="bcItem">${htmlBuscadorCanciones()}</div>
      <div id="usoCancion"></div>
      <div class="fila">
        <div><label>Cantante</label><select name="cantante_id"><option value="">Sin asignar</option>${lista.map(p =>
          `<option value="${p.id}" ${p.id === it?.cantante_id ? 'selected' : ''}>${delDia.has(p.id) ? '★ ' : ''}${esc(p.nombre)}</option>`).join('')}</select></div>
        <div><label>Tono</label><select name="tono">${opcionesTono(it?.tono || '', TODOS_LOS_TONOS, 'Original')}</select></div>
      </div>
      <p class="ayuda" id="ayudaTono"></p>
      ${st.faltaV6 ? '' : `<label>Ritmo en este día</label><select name="ritmo"><option value="">Según la canción</option>${Object.entries(RITMOS).map(([k, v]) =>
        `<option value="${k}" ${it?.ritmo === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`}
      <label>Nota (opcional)</label><input name="notas" maxlength="200" value="${esc(it?.notas)}" placeholder="Ej: solo coro, versión corta">
      <label class="check"><input type="checkbox" name="recordar" checked> Guardar este tono para el cantante</label>
      <button class="btn prim blk" type="submit">${it ? 'Guardar' : 'Agregar'}</button>
      ${it ? `<button class="btn peligro blk" type="button" id="bQuitar">Quitar del repertorio</button>` : ''}
    </form>`);
  const form = $('#fItem', body);
  const sugerir = () => {
    const c = canciones.find(x => x.id === form.cancion_id.value);
    const guardado = tonoGuardado(form.cancion_id.value, form.cantante_id.value);
    if (guardado) form.tono.value = guardado;
    else if (c?.tono_original && !it) form.tono.value = c.tono_original;
    $('#ayudaTono', body).textContent = c
      ? `Original: ${tonoTxt(c.tono_original)}${guardado ? ` · ${nombreDe(form.cantante_id.value)} la canta en ${tonoTxt(guardado)}` : ''}`
      : '';
    const uso = $('#usoCancion', body);
    if (uso) {
      const h = hist.get(form.cancion_id.value);
      uso.innerHTML = !c || !hist.size ? '' : h
        ? `<div class="uso-box ${frescura(h)}">🕒 <b>${esc(txtUltima(h.ultima_vez))}</b> · ${h.veces_90d} ${h.veces_90d === 1 ? 'vez' : 'veces'} en 3 meses · ${h.veces_total} en total${frescura(h) === 'reciente' ? '<br><small>Se cantó hace poco</small>' : ''}</div>`
        : '<div class="uso-box nueva">✨ Primera vez en el repertorio</div>';
    }
    const optR = form.ritmo?.querySelector('option[value=""]');
    if (optR) optR.textContent = `Según la canción${c?.ritmo ? ` (${RITMOS[c.ritmo]})` : ' (sin definir)'}`;
  };
  const yaEnDia = new Set(items.filter(x => x.id !== it?.id).map(x => x.cancion_id));
  iniciarBuscadorCanciones($('#bcItem', body), canciones, {
    valor: it?.cancion_id || '',
    etiqueta: c => [yaEnDia.has(c.id) ? '✔️ ya está en este día' : '', hist.size ? (hist.has(c.id) ? txtUltima(hist.get(c.id).ultima_vez).toLowerCase() : 'nueva') : ''].filter(Boolean).join(' · '),
    alElegir: sugerir,
  });
  form.cantante_id.onchange = sugerir;
  if (!it) {
    // Por defecto, el cantante que dirige ese día (o la única voz asignada)
    const voces = (s.asignaciones || []).filter(a => a.rol === 'voz' && a.estado !== 'rechazado');
    const pre = voces.find(a => a.dirige) || (voces.length === 1 ? voces[0] : null);
    if (pre && form.cantante_id.querySelector(`option[value="${pre.perfil_id}"]`)) form.cantante_id.value = pre.perfil_id;
    sugerir();
  }

  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = Object.fromEntries(new FormData(form));
      if (!f.cancion_id) return toast('Busca y elige una canción', true);
      const can = canciones.find(x => x.id === f.cancion_id);
      const datos = { cancion_id: f.cancion_id, cantante_id: f.cantante_id || null, tono: f.tono || null, notas: f.notas.trim() || null,
        ...(st.faltaV6 ? {} : { ritmo: f.ritmo && f.ritmo !== can?.ritmo ? f.ritmo : null }) };
      const { error } = it
        ? await sb.from('setlist_items').update(datos).eq('id', it.id)
        : await sb.from('setlist_items').insert({ ...datos, setlist_id: s.id, orden: items.length ? Math.max(...items.map(x => x.orden)) + 1 : 0 });
      if (error) return fallo(error, 'Repertorio');
      if (f.recordar && datos.cantante_id && datos.tono) {
        const { error: e2 } = await sb.from('tonos_cantante')
          .upsert({ cancion_id: datos.cancion_id, cantante_id: datos.cantante_id, tono: datos.tono }, { onConflict: 'cancion_id,cantante_id' });
        if (e2) fallo(e2, 'Tono');
      }
      cerrarModal(); toast(it ? 'Actualizado' : 'Canción agregada'); rutear();
    });
  };
  const bq = $('#bQuitar', body);
  if (bq) bq.onclick = async () => {
    if (!confirm('¿Quitar esta canción del repertorio del día? (Sigue en el módulo Canciones.)')) return;
    const { error } = await sb.from('setlist_items').delete().eq('id', it.id);
    if (error) return fallo(error, 'Repertorio');
    cerrarModal(); toast('Quitada del repertorio'); rutear();
  };
}

async function compartirDia(s, items) {
  const t = tipoDe(s);
  const asig = (s.asignaciones || []).filter(a => a.estado !== 'rechazado');
  const porRol = roles => gruposRol(asig, roles).map(([et, as]) => `• ${et}: ${as.map(a => nombreDe(a.perfil_id)).join(', ')}`);
  const canto = porRol(ROLES_CANTO), instr = porRol(Object.keys(ROLES).filter(r => !ROLES_CANTO.includes(r)));
  const txt = [
    `${t.emoji} *${s.titulo}*`,
    `📅 ${fmtFechaLarga(s.fecha)} · ${fmtHora(s.fecha)}`,
    s.ensayo_fecha ? `🎹 Ensayo: ${fmtFechaLarga(s.ensayo_fecha)} · ${fmtHora(s.ensayo_fecha)}` : null,
    s.lugar ? `📍 ${s.lugar}` : null,
    canto.length ? `\n🎤 *Cantores*\n${canto.join('\n')}` : null,
    instr.length ? `\n🎸 *Instrumentistas*\n${instr.join('\n')}` : null,
    items.length ? `\n🎵 *Canciones*\n${items.map((it, i) => {
      const ic = ICON_RITMO[ritmoDe(it)] ? ICON_RITMO[ritmoDe(it)] + ' ' : '';
      return `${i + 1}. ${ic}${it.cancion.titulo} — ${tonoTxt(it.tono || it.cancion.tono_original)}${it.cantante_id ? ` (${nombreDe(it.cantante_id)})` : ''}`;
    }).join('\n')}` : null,
    s.notas ? `\n📝 ${s.notas}` : null,
    `\n${baseUrl()}#/dia/${s.id}`,
  ].filter(x => x !== null).join('\n');
  if (navigator.share) {
    try { await navigator.share({ text: txt }); } catch {}
  } else {
    window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank', 'noopener');
  }
}

// =====================================================================
// EQUIPO
// =====================================================================
async function vistaEquipo(ctx) {
  cargando('Equipo');
  await cargarPerfiles();
  if (!ctx.vigente()) return;
  const todos = [...st.perfiles.values()];
  const pend = todos.filter(p => p.estado === 'pendiente');
  const bloq = todos.filter(p => p.estado === 'bloqueado');
  const grupos = {};
  aprobados().forEach(p => (grupos[p.instrumento || 'otro'] ??= []).push(p));
  const filaMiembro = p => `
    <div class="item" style="cursor:default">
      <span class="avatar sm">${esc(iniciales(p.nombre))}</span>
      <div class="info"><b>${esc(p.nombre)} ${p.rol === 'admin' ? '<span class="tag fijada">Admin</span>' : ''}</b>
        <small>${esc(INSTRUMENTOS[p.instrumento] || 'Sin instrumento')}${esAdmin() ? ' · ' + esc(p.email || '') : ''}</small></div>
      ${esAdmin() && p.id !== st.uid ? `<button class="btn-ico" data-acc="menu" data-id="${p.id}" aria-label="Opciones">⋯</button>` : ''}
    </div>`;
  app.innerHTML = encabezado('Equipo', { sub: `${aprobados().length} integrantes` }) + `
    ${esAdmin() && pend.length ? `<div class="seccion-t" style="margin-top:4px;color:var(--peligro)">Pendientes de aprobar (${pend.length})</div>
      <div class="lista">${pend.map(p => `
        <div class="item" style="cursor:default">
          <span class="avatar sm">${esc(iniciales(p.nombre))}</span>
          <div class="info"><b>${esc(p.nombre)}</b><small>${esc(INSTRUMENTOS[p.instrumento] || '—')} · ${esc(p.email || '')}</small></div>
          <div class="miembro-acc">
            <button class="btn sm prim" data-acc="aprobar" data-id="${p.id}">Aprobar</button>
            <button class="btn sm" data-acc="bloquear" data-id="${p.id}">✕</button>
          </div>
        </div>`).join('')}</div>` : ''}
    ${Object.entries(INSTRUMENTOS).filter(([k]) => grupos[k]).map(([k, v]) => `
      <div class="seccion-t">${esc(v)} (${grupos[k].length})</div>
      <div class="lista">${grupos[k].map(filaMiembro).join('')}</div>`).join('')}
    ${esAdmin() && bloq.length ? `<div class="seccion-t">Desactivados</div><div class="lista">${bloq.map(p => `
      <div class="item" style="cursor:default"><div class="info"><b>${esc(p.nombre)}</b><small>${esc(p.email || '')}</small></div>
      <button class="btn sm" data-acc="aprobar" data-id="${p.id}">Reactivar</button></div>`).join('')}</div>` : ''}
    ${esAdmin() ? '<div class="seccion-t">🖥️ Link de solo lectura</div><div class="card" id="accesoPub"><p class="ayuda" style="margin:0">Cargando…</p></div>' : ''}`;
  if (esAdmin()) pintarAccesoPublico(ctx);

  const actualizar = async (id, cambios, msg) => {
    const { error } = await sb.from('profiles').update(cambios).eq('id', id);
    if (error) return fallo(error, 'Equipo');
    toast(msg); cerrarModal(); rutear();
  };
  app.onclick = e => {
    const el = e.target.closest('[data-acc]');
    if (!el) return;
    const p = st.perfiles.get(el.dataset.id);
    if (el.dataset.acc === 'aprobar') actualizar(p.id, { estado: 'aprobado' }, `${p.nombre} aprobado`);
    else if (el.dataset.acc === 'bloquear') { if (confirm(`¿Rechazar/desactivar a ${p.nombre}?`)) actualizar(p.id, { estado: 'bloqueado' }, 'Desactivado'); }
    else if (el.dataset.acc === 'menu') {
      const body = abrirModal(p.nombre, `
        <p class="ayuda" style="margin-top:0">${esc(p.email || '')}</p>
        <label>Instrumento / rol en el equipo</label><select id="mInstr">${opcionesInstrumento(p.instrumento)}</select>
        <button class="btn blk" id="mGuardar">Guardar instrumento</button>
        <button class="btn blk" id="mTonos">🎤 Ver / editar sus tonos</button>
        <button class="btn blk" id="mAdmin">${p.rol === 'admin' ? 'Quitar administrador' : '⭐ Hacer administrador'}</button>
        <button class="btn peligro blk" id="mBloq">Desactivar acceso</button>`);
      $('#mTonos', body).onclick = () => modalTonosDe(p.id);
      $('#mGuardar', body).onclick = () => actualizar(p.id, { instrumento: $('#mInstr', body).value }, 'Guardado');
      $('#mAdmin', body).onclick = () => actualizar(p.id, { rol: p.rol === 'admin' ? 'miembro' : 'admin' }, 'Rol actualizado');
      $('#mBloq', body).onclick = () => confirm(`¿Desactivar a ${p.nombre}?`) && actualizar(p.id, { estado: 'bloqueado' }, 'Desactivado');
    }
  };
}

// ---------- link público de solo lectura (programa.html?k=…) ----------
async function pintarAccesoPublico(ctx) {
  const caja = $('#accesoPub');
  const { data, error } = await sb.from('acceso_publico').select('*').eq('id', 1).maybeSingle();
  if (!ctx.vigente() || !caja) return;
  if (error || !data) {
    caja.innerHTML = '<p class="ayuda" style="margin:0">⚠️ Para activarlo ejecuta <b>supabase/007_programa_publico.sql</b> en Supabase → SQL Editor.</p>';
    return;
  }
  const link = `${baseUrl().replace(/index\.html$/, "")}programa.html?k=${data.token}`;
  caja.innerHTML = `
    <p class="ayuda" style="margin-top:0">Para equipos que solo necesitan ver el programa (p. ej. Proper Center): días, quién canta y canciones con autor, video y letra sin acordes. No necesitan cuenta.</p>
    <p style="margin:6px 0">Estado: <b style="color:var(--${data.activo ? 'ok' : 'peligro'})">${data.activo ? '✅ Activo' : '⛔ Desactivado'}</b></p>
    ${data.activo ? `<input readonly value="${esc(link)}" onclick="this.select()" style="font-size:12px">
    <div class="fila" style="margin-top:8px">
      <button class="btn sm prim" data-pub="copiar">📋 Copiar link</button>
      <button class="btn sm" data-pub="compartir">📤 Compartir</button>
      <a class="btn sm" href="${esc(link)}" target="_blank" rel="noopener">👁️ Ver</a>
    </div>` : ''}
    <div class="fila" style="margin-top:8px">
      <button class="btn sm" data-pub="regenerar">🔄 Cambiar link</button>
      <button class="btn sm ${data.activo ? 'peligro' : ''}" data-pub="activo">${data.activo ? '⛔ Desactivar' : '✅ Activar'}</button>
    </div>
    <p class="ayuda" style="margin-bottom:0">"Cambiar link" invalida el anterior: úsalo si el link llegó a quien no debía.</p>`;
  caja.onclick = async e => {
    const b = e.target.closest('[data-pub]');
    if (!b) return;
    e.stopPropagation();
    const acc = b.dataset.pub;
    if (acc === 'copiar') {
      try { await navigator.clipboard.writeText(link); toast('Link copiado'); } catch { toast('No se pudo copiar', true); }
    } else if (acc === 'compartir') {
      const txt = `📅 Programa de Alabanza · Roca de Vida\nDías, quién canta y canciones (con video y letra):\n${link}`;
      if (navigator.share) { try { await navigator.share({ text: txt }); } catch {} }
      else window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank', 'noopener');
    } else if (acc === 'regenerar') {
      if (!confirm('El link actual dejará de funcionar y tendrás que enviar el nuevo. ¿Continuar?')) return;
      const nuevo = [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
      const { error: er } = await sb.from('acceso_publico').update({ token: nuevo, updated_at: new Date().toISOString() }).eq('id', 1);
      if (er) return fallo(er, 'Link');
      toast('Link nuevo creado'); pintarAccesoPublico(ctx);
    } else if (acc === 'activo') {
      const { error: er } = await sb.from('acceso_publico').update({ activo: !data.activo, updated_at: new Date().toISOString() }).eq('id', 1);
      if (er) return fallo(er, 'Link');
      toast(data.activo ? 'Link desactivado' : 'Link activado'); pintarAccesoPublico(ctx);
    }
  };
}

// =====================================================================
// PERFIL
// =====================================================================
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); st.instalarEvt = e; });

async function descargarSinConexion(btn) {
  if (!navigator.onLine) return toast('Necesitas internet para descargar', true);
  const txt = btn.textContent;
  btn.disabled = true;
  const paso = t => (btn.textContent = t);
  try {
    paso('Descargando canciones…');
    const desde = isoSinMs(new Date(Date.now() - 12 * 3600e3));
    const [rc, rn, rt, rp, rs] = await Promise.all([
      sb.from('canciones').select('*').order('titulo'),
      sb.from('notas_cancion').select('*'),
      sb.from('tonos_cantante').select('*'),
      sb.from('partituras').select('*').order('created_at'),
      st.faltaV2 ? Promise.resolve({ data: [] }) : sb.from('setlists').select(selDia()).gte('fecha', desde).order('fecha').limit(40),
    ]);
    const err = [rc, rn, rt, rs].find(r => r.error)?.error;
    if (err) throw err;
    const parts = rp.error ? [] : rp.data;
    const k = c => `${st.uid}:${c}`;
    const por = (arr, campo) => arr.reduce((m, x) => ((m[x[campo]] ??= []).push(x), m), {});
    const notas = por(rn.data, 'cancion_id'), tonos = por(rt.data, 'cancion_id'), pp = por(parts, 'cancion_id');
    await idb.set(k('canciones'), rc.data.map(({ id, titulo, artista, tono_original }) => ({ id, titulo, artista, tono_original })));
    await idb.set(k('partituras-idx'), parts.map(({ cancion_id, instrumento }) => ({ cancion_id, instrumento })));
    for (const c of rc.data) {
      await idb.set(k('cancion:' + c.id), c);
      await idb.set(k('notas:' + c.id), notas[c.id] || []);
      await idb.set(k('tonos:' + c.id), tonos[c.id] || []);
      await idb.set(k('partituras:' + c.id), pp[c.id] || []);
    }
    paso('Descargando agenda…');
    await idb.set(k('proximos'), rs.data);
    const ids = rs.data.map(s => s.id);
    if (ids.length) {
      const { data: its, error } = await sb.from('setlist_items').select(selItems()).in('setlist_id', ids).order('orden');
      if (error) throw error;
      const pi = por(its, 'setlist_id');
      for (const s of rs.data) { await idb.set(k('dia:' + s.id), s); await idb.set(k('items:' + s.id), pi[s.id] || []); }
    }
    const archivos = parts.filter(p => p.tipo !== 'link');
    let ok = 0;
    const cache = await caches.open('alabanza-archivos');
    for (const [i, p] of archivos.entries()) {
      paso(`Descargando partituras ${i + 1}/${archivos.length}…`);
      try { if (!(await cache.match(p.url))) { const r = await fetch(p.url); if (r.ok) await cache.put(p.url, r); } ok++; } catch {}
    }
    try { localStorage.setItem('alabanza.descarga', new Date().toISOString()); } catch {}
    $('#ultDescarga') && ($('#ultDescarga').textContent = 'Última descarga: ahora');
    toast(`Listo: ${rc.data.length} canciones, ${rs.data.length} días y ${ok} partituras disponibles sin internet`);
  } catch (e) { fallo(e, 'Descarga'); }
  finally { btn.disabled = false; btn.textContent = txt; }
}

function vistaPerfil() {
  const p = st.perfil;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  app.innerHTML = encabezado('Mi perfil', { atras: '#/equipo' }) + `
    <form id="fPerfil" class="card">
      <label style="margin-top:0">Nombre</label><input name="nombre" required maxlength="60" value="${esc(p.nombre)}">
      <label>Instrumento / rol</label><select name="instrumento">${opcionesInstrumento(p.instrumento)}</select>
      <p class="ayuda">${esc(p.email || '')} · ${p.rol === 'admin' ? 'Administrador' : 'Miembro'}</p>
      <button class="btn prim blk">Guardar</button>
    </form>
    <div class="card">
      <b>🎨 Apariencia</b>
      <div class="seg" id="segTema">${[['auto', '📱 Automático'], ['claro', '☀️ Claro'], ['oscuro', '🌙 Oscuro']].map(([k, v]) =>
        `<button type="button" data-tema="${k}" class="${(ajustes.tema || 'auto') === k ? 'activo' : ''}">${v}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="chkLatino" ${ajustes.latino ? 'checked' : ''}> Mostrar acordes en cifrado latino (Do, Re, Mi…)</label>
    </div>
    <div class="card" id="cardTonos"></div>
    <div id="cardNotif"></div>
    <div id="cardIndisp"></div>
    ${!standalone ? `<div class="card instalar">
      <p>📲 ${ios ? 'Para instalar en iPhone: abre en <b>Safari</b>, toca <b>Compartir</b> ⬆️ y luego <b>"Agregar a inicio"</b>.' : 'Instala la app en tu celular para abrirla como cualquier otra.'}</p>
      ${!ios ? `<button class="btn sm prim" id="bInstalar">Instalar</button>` : ''}
    </div>` : ''}
    <div class="card">
      <b>📴 Usar sin internet</b>
      <p class="ayuda" style="margin:4px 0 10px">Descarga todas las canciones (letra, notas, tonos y partituras) y los próximos días de la agenda para verlos sin señal. Lo que abras con internet también se guarda solo.</p>
      <button class="btn prim blk" id="bOffline" style="margin-top:0">⬇️ Descargar para usar sin internet</button>
      <p class="ayuda" id="ultDescarga">${(() => { try { const t = localStorage.getItem('alabanza.descarga'); return t ? 'Última descarga: ' + haceCuanto(t) : ''; } catch { return ''; } })()}</p>
    </div>
    <button class="btn blk" id="bClave">Cambiar contraseña</button>
    <button class="btn peligro blk" id="bSalir">Cerrar sesión</button>
    <p class="ayuda" style="text-align:center;margin-top:20px">${esc(APP_NOMBRE)}</p>`;
  $('#fPerfil').onsubmit = e => {
    e.preventDefault();
    ocupado(e.target.querySelector('button'), async () => {
      const f = Object.fromEntries(new FormData(e.target));
      const { error } = await sb.from('profiles').update({ nombre: f.nombre.trim(), instrumento: f.instrumento }).eq('id', st.uid);
      if (error) return fallo(error, 'Perfil');
      st.perfil = { ...st.perfil, nombre: f.nombre.trim(), instrumento: f.instrumento };
      st.perfiles.set(st.uid, st.perfil);
      toast('Perfil actualizado'); rutear();
    });
  };
  $('#chkLatino').onchange = e => { ajustes.latino = e.target.checked; guardarAjustes(); toast('Listo'); };
  $('#segTema').onclick = e => {
    const b = e.target.closest('[data-tema]'); if (!b) return;
    ajustes.tema = b.dataset.tema; guardarAjustes(); aplicarTema();
    $('#segTema').querySelectorAll('button').forEach(x => x.classList.toggle('activo', x === b));
  };
  pintarMisTonos();
  $('#bClave').onclick = modalNuevaClave;
  $('#bSalir').onclick = async () => { await idb.limpiar(); await sb.auth.signOut(); location.hash = ''; };
  $('#bOffline').onclick = e => descargarSinConexion(e.currentTarget);
  pintarNotif();
  pintarIndisp();
  const bi = $('#bInstalar');
  if (bi) bi.onclick = async () => {
    if (st.instalarEvt) { st.instalarEvt.prompt(); st.instalarEvt = null; }
    else toast('Usa el menú ⋮ del navegador → "Instalar app" o "Agregar a pantalla principal"');
  };
}


// =====================================================================
// TONOS POR CANTANTE (Mi perfil y Equipo)
// =====================================================================
async function cargarTonosDe(perfilId) {
  const { data, error } = await conCache('tonosDe:' + perfilId,
    sb.from('tonos_cantante').select('id, tono, notas, updated_at, cancion_id, cancion:canciones(id, titulo, artista, tono_original)').eq('cantante_id', perfilId));
  if (error) throw error;
  return (data || []).filter(t => t.cancion).sort((a, b) => a.cancion.titulo.localeCompare(b.cancion.titulo));
}

const filaTono = (t, extra = '') => `
  <div class="item" data-tono="${t.id}">
    <span class="tono-pill">${esc(tonoTxt(t.tono))}</span>
    <div class="info"><b>${esc(t.cancion.titulo)}</b><small>Original ${esc(tonoTxt(t.cancion.tono_original))}${t.notas ? ' · ' + esc(t.notas) : ''}</small></div>
    ${extra}
  </div>`;

async function pintarMisTonos() {
  const card = $('#cardTonos');
  if (!card) return;
  card.innerHTML = '<b>🎤 Mis tonos</b><p class="ayuda">Cargando…</p>';
  let tonos;
  try { tonos = await cargarTonosDe(st.uid); } catch (e) { card.innerHTML = '<b>🎤 Mis tonos</b><p class="ayuda">No se pudieron cargar.</p>'; return; }
  if (!$('#cardTonos')) return;
  if (!tonos.length && st.perfil.instrumento !== 'voz') { card.remove(); return; }
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><b>🎤 Mis tonos (${tonos.length})</b>
      <button class="btn sm" id="bTonos" style="margin:0">✏️ Gestionar</button></div>
    <p class="ayuda" style="margin:4px 0 10px">Cuando te asignen una canción en un día, se usa tu tono guardado. Un administrador también puede ajustarlo.</p>
    <div class="lista">${tonos.map(filaTono).join('') || '<p class="ayuda">Aún no tienes tonos guardados.</p>'}</div>`;
  $('#bTonos').onclick = () => modalTonosDe(st.uid, pintarMisTonos);
  card.querySelectorAll('[data-tono]').forEach(el => (el.onclick = () => modalTonosDe(st.uid, pintarMisTonos, el.dataset.tono)));
}

/** Lista y edita los tonos de un cantante. Lo usa el propio cantante (Mi perfil) o un admin (Equipo). */
async function modalTonosDe(perfilId, alCambiar = () => {}, tonoSel = null) {
  const propio = perfilId === st.uid;
  if (!propio && !esAdmin()) return;
  let tonos, canciones;
  try {
    const [t, rc] = await Promise.all([cargarTonosDe(perfilId), conCache('canciones:min', sb.from('canciones').select('id, titulo, artista, tono_original').order('titulo'))]);
    if (rc.error) throw rc.error;
    tonos = t; canciones = rc.data || [];
  } catch (e) { return fallo(e, 'Tonos'); }
  const body = abrirModal(propio ? 'Mis tonos' : `Tonos de ${nombreDe(perfilId)}`, `
    <p class="ayuda" style="margin-top:0">Toca una canción para cambiar su tono. Se aplica también a los próximos días donde ${propio ? 'te toque' : 'le toque'} cantarla.</p>
    <div class="lista" id="lTonos">${tonos.map(t => filaTono(t, `<button class="btn-ico" data-borrar="${t.id}" aria-label="Eliminar">🗑️</button>`)).join('') || '<p class="ayuda">Aún no hay tonos guardados.</p>'}</div>
    <form id="fTonoDe" style="margin-top:12px">
      <label>Canción</label>
      <div id="bcTono">${htmlBuscadorCanciones()}</div>
      <div class="fila">
        <div><label>Tono</label><select name="tono" required>${opcionesTono('', TODOS_LOS_TONOS, 'Elige…')}</select></div>
        <div><label>Original</label><input id="tOrig" disabled value="—"></div>
      </div>
      <label>Nota (opcional)</label><input name="notas" maxlength="200" placeholder="Ej: con capo 2, baja en el puente">
      <button class="btn prim blk">Guardar tono</button>
    </form>`);
  const form = $('#fTonoDe', body);
  const precargar = () => {
    const c = canciones.find(x => x.id === form.cancion_id.value);
    const t = tonos.find(x => x.cancion_id === form.cancion_id.value);
    $('#tOrig', body).value = c ? tonoTxt(c.tono_original) : '—';
    form.tono.value = t?.tono || c?.tono_original || '';
    form.notas.value = t?.notas || '';
  };
  const conTono = new Map(tonos.map(t => [t.cancion_id, t]));
  const bc = iniciarBuscadorCanciones($('#bcTono', body), canciones, {
    etiqueta: c => (conTono.has(c.id) ? `🎤 guardado en ${tonoTxt(conTono.get(c.id).tono)}` : ''),
    alElegir: precargar,
  });
  const elegir = id => {
    const t = tonos.find(x => x.id === id); if (!t) return;
    bc.elegir(t.cancion_id);
    form.scrollIntoView({ behavior: 'smooth', block: 'end' }); form.tono.focus();
  };
  if (tonoSel) elegir(tonoSel);
  $('#lTonos', body).onclick = async e => {
    const b = e.target.closest('[data-borrar]');
    if (b) {
      if (!confirm('¿Eliminar este tono guardado?')) return;
      const { error } = await sb.from('tonos_cantante').delete().eq('id', b.dataset.borrar);
      if (error) return fallo(error, 'Tono');
      toast('Tono eliminado'); cerrarModal(); alCambiar(); return;
    }
    const fila = e.target.closest('[data-tono]');
    if (fila) elegir(fila.dataset.tono);
  };
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('button'), async () => {
      const f = Object.fromEntries(new FormData(form));
      if (!f.cancion_id) return toast('Busca y elige una canción', true);
      const { error } = await sb.from('tonos_cantante').upsert(
        { cancion_id: f.cancion_id, cantante_id: perfilId, tono: f.tono, notas: f.notas.trim() || null },
        { onConflict: 'cancion_id,cantante_id' });
      if (error) return fallo(error, 'Tono');
      toast('Tono guardado · aplicado a los próximos días'); cerrarModal(); alCambiar();
    });
  };
}

// =====================================================================
// MENCIONES
// =====================================================================
const RX_MEN = /@\[([^\]]+)\]\((grupo|[0-9a-f-]{36})\)/g;
const GRUPOS_MEN = { todos: 'Todos los del día', voces: 'Voces del día', musicos: 'Músicos del día', admins: 'Administradores', pendientes: 'Sin confirmar del día' };

function enGrupo(g, s) {
  if (g === 'admins') return esAdmin();
  const mias = (s?.asignaciones || []).filter(a => a.perfil_id === st.uid);
  if (g === 'todos') return mias.length > 0;
  if (g === 'voces') return mias.some(a => a.rol === 'voz');
  if (g === 'musicos') return mias.some(a => a.rol !== 'voz');
  if (g === 'pendientes') return mias.some(a => SIN_CONFIRMAR.includes(a.estado));
  return false;
}
const esParaMi = (n, id, s) => id === st.uid || (id === 'grupo' && enGrupo(n, s));
function textoConMenciones(t, s) {
  return esc(t).replace(RX_MEN, (_, n, id) => `<span class="mencion${esParaMi(n, id, s) ? ' a-mi' : ''}${id === 'grupo' ? ' grupo' : ''}">@${n}</span>`);
}
const mencionaA = (t, s) => [...String(t || '').matchAll(RX_MEN)].some(m => esParaMi(m[1], m[2], s));

async function iniciarGlobal() {
  if (st.canalGlobal) { sb.removeChannel(st.canalGlobal); st.canalGlobal = null; }
  if (!navigator.onLine) return;
  const r = await sb.from('menciones').select('id', { count: 'exact', head: true }).eq('perfil_id', st.uid).is('leido_at', null);
  st.faltaV7 = !!r.error && !esErrorRed(r.error);
  if (r.error) return;
  ponerBadgeMen(r.count || 0, !!r.count);
  st.canalGlobal = sb.channel('menciones-' + st.uid)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'menciones', filter: `perfil_id=eq.${st.uid}` }, async ({ new: m }) => {
      const { data } = await sb.from('mensajes_evento').select('autor_id, setlist_id').eq('id', m.mensaje_id).maybeSingle();
      if (data && location.hash.startsWith('#/dia/' + data.setlist_id)) {
        await sb.from('menciones').update({ leido_at: new Date().toISOString() }).eq('id', m.id);
        return;
      }
      ponerBadgeMen(st.menNoLeidas + 1, true);
      if (data) aviso(`💬 ${nombreDe(data.autor_id)} te mencionó · toca para ver`, `#/dia/${data.setlist_id}?men=${m.mensaje_id}`);
    })
    .subscribe();
}

function ponerBadgeMen(n, animar = false) {
  st.menNoLeidas = Math.max(0, n);
  document.querySelectorAll('.men-badge').forEach(b => {
    b.hidden = !st.menNoLeidas;
    b.textContent = st.menNoLeidas > 9 ? '9+' : st.menNoLeidas;
    if (animar) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  });
  if (animar) document.querySelectorAll('.campana').forEach(c => { c.classList.remove('sonando'); void c.offsetWidth; c.classList.add('sonando'); });
}

async function marcarLeidas(setId) {
  if (st.faltaV7 || !navigator.onLine) return;
  const { data } = await sb.from('menciones').select('id, mensaje:mensajes_evento!inner(setlist_id)')
    .eq('perfil_id', st.uid).is('leido_at', null).eq('mensaje.setlist_id', setId);
  if (!data?.length) return;
  const { error } = await sb.from('menciones').update({ leido_at: new Date().toISOString() }).in('id', data.map(m => m.id));
  if (!error) ponerBadgeMen(st.menNoLeidas - data.length);
}

/** Aviso que baja desde arriba; al tocarlo lleva a href. */
function aviso(msg, href) {
  const a = document.createElement('a');
  a.className = 'aviso-top'; a.href = href; a.textContent = msg;
  document.body.appendChild(a);
  navigator.vibrate?.(40);
  requestAnimationFrame(() => requestAnimationFrame(() => a.classList.add('ver')));
  const quitar = () => { a.classList.remove('ver'); setTimeout(() => a.remove(), 400); };
  a.addEventListener('click', quitar);
  setTimeout(quitar, 5500);
}

async function modalMenciones() {
  if (st.faltaV7) return toast(esAdmin() ? 'Ejecuta supabase/007_menciones_push.sql en Supabase' : 'Las menciones aún no están activadas', true);
  abrirModal('Menciones', '<div class="spinner"></div>');
  const { data, error } = await conCache('menciones', sb.from('menciones')
    .select('id, leido_at, created_at, mensaje:mensajes_evento(id, texto, autor_id, setlist_id, setlist:setlists(titulo, fecha))')
    .eq('perfil_id', st.uid).order('created_at', { ascending: false }).limit(40));
  if (!dlg.open) return;
  if (error) { abrirModal('Menciones', '<div class="vacio">No se pudieron cargar las menciones.</div>'); return; }
  const lista = (data || []).filter(m => m.mensaje);
  const noLeidas = lista.filter(m => !m.leido_at).length;
  const body = abrirModal('Menciones', `
    ${noLeidas ? '<button class="btn sm" data-todas style="margin-bottom:10px">✓ Marcar todas como leídas</button>' : ''}
    <div class="men-lista">${lista.map(m => `
      <a class="men-item${m.leido_at ? '' : ' no-leida'}" href="#/dia/${m.mensaje.setlist_id}?men=${m.mensaje.id}">
        <span class="avatar sm">${esc(iniciales(nombreDe(m.mensaje.autor_id)))}</span>
        <span class="info">
          <span class="quien"><b>${esc(nombreDe(m.mensaje.autor_id))}</b><small>${esc(haceCuanto(m.created_at))}</small></span>
          <span class="donde">${esc(m.mensaje.setlist?.titulo || 'Chat del día')}${m.mensaje.setlist?.fecha ? ' · ' + esc(fmtCorta(m.mensaje.setlist.fecha)) : ''}</span>
          <span class="txt">${textoConMenciones(m.mensaje.texto, null)}</span>
        </span>
      </a>`).join('') || '<div class="vacio"><span class="grande">💬</span>Nadie te ha mencionado todavía.<br><small>Cuando alguien escriba @ con tu nombre en un chat, aparecerá aquí.</small></div>'}</div>`);
  body.onclick = async e => {
    if (e.target.closest('.men-item')) return cerrarModal();
    if (!e.target.closest('[data-todas]')) return;
    const { error: e2 } = await sb.from('menciones').update({ leido_at: new Date().toISOString() }).eq('perfil_id', st.uid).is('leido_at', null);
    if (e2) return fallo(e2, 'Menciones');
    ponerBadgeMen(0); toast('Listo'); cerrarModal();
  };
  dlg.addEventListener('close', () => (body.onclick = null), { once: true });
}

document.addEventListener('click', e => { if (e.target.closest('[data-men]')) modalMenciones(); });

// =====================================================================
// HISTORIAL DE CANCIONES
// =====================================================================
async function cargarHistorial() {
  if (st.historial && Date.now() - st.historialT < 60000) return st.historial;
  const { data, error } = await conCache('historial', sb.from('historial_canciones').select('*'));
  st.historial = new Map((error ? [] : data || []).map(h => [h.cancion_id, h]));
  st.historialT = Date.now();
  return st.historial;
}
function haceDias(iso) {
  if (!iso) return null;
  const a = new Date(claveDia(new Date(iso)) + 'T00:00'), b = new Date(claveDia(new Date()) + 'T00:00');
  return Math.round((b - a) / 864e5);
}
function txtUltima(iso) {
  const d = haceDias(iso);
  if (d == null) return 'Nunca se ha cantado';
  if (d <= 0) return 'Hoy';
  if (d === 1) return 'Ayer';
  if (d < 14) return `Hace ${d} días`;
  if (d < 60) return `Hace ${Math.round(d / 7)} semanas`;
  const m = Math.round(d / 30);
  return m < 12 ? `Hace ${m} meses` : 'Hace más de un año';
}
/** reciente (< 3 semanas) · media · fria (> 3 meses) · nueva (nunca) */
const frescura = h => { const d = haceDias(h?.ultima_vez); return d == null ? 'nueva' : d < 21 ? 'reciente' : d < 90 ? 'media' : 'fria'; };

// =====================================================================
// INDISPONIBILIDAD
// =====================================================================
async function cargarIndisp(desde, hasta) {
  if (st.faltaV7) return [];
  const { data, error } = await conCache(`indisp:${desde}:${hasta}`, sb.from('indisponibilidad')
    .select('perfil_id, desde, hasta, motivo').lte('desde', hasta).gte('hasta', desde));
  return error ? [] : data || [];
}
const fmtDiaK = k => new Date(k + 'T00:00').toLocaleDateString('es-PA', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');
const fmtRango = (d, h) => (d === h ? fmtDiaK(d) : `${fmtDiaK(d)} → ${fmtDiaK(h)}`);

async function pintarIndisp() {
  let box = $('#cardIndisp');
  if (!box) return;
  const hoyK = claveDia(new Date());
  const { data, error } = await sb.from('indisponibilidad').select('*').eq('perfil_id', st.uid).gte('hasta', hoyK).order('desde');
  box = $('#cardIndisp');
  if (!box) return;
  if (error) {
    box.innerHTML = esErrorRed(error) || !esAdmin() ? ''
      : '<div class="card" style="border-color:var(--peligro)">⚠️ Para activar menciones, fechas no disponibles y notificaciones ejecuta <b>supabase/007_menciones_push.sql</b> en Supabase → SQL Editor.</div>';
    return;
  }
  box.innerHTML = `<div class="card">
    <b>🚫 Fechas que no puedo servir</b>
    <p class="ayuda" style="margin:4px 0 10px">Los administradores lo verán al armar el equipo de cada día.</p>
    <div class="indisp-lista">${data.map(i => `<div class="indisp-item">
      <span class="rango">${esc(fmtRango(i.desde, i.hasta))}</span><small>${esc(i.motivo || '')}</small>
      <button class="x" data-ind="${i.id}" aria-label="Quitar">✕</button></div>`).join('') || '<p class="ayuda" style="margin:0 0 6px">No tienes fechas marcadas.</p>'}</div>
    <form id="fIndisp">
      <div class="fila"><div><label>Desde</label><input type="date" name="desde" required min="${hoyK}"></div>
        <div><label>Hasta</label><input type="date" name="hasta" required min="${hoyK}"></div></div>
      <label>Motivo (opcional)</label><input name="motivo" maxlength="120" placeholder="Viaje, trabajo…">
      <button class="btn prim blk" style="margin-top:12px">Agregar fechas</button>
    </form></div>`;
  const f = box.querySelector('#fIndisp');
  if (!f) return;
  f.desde.onchange = () => { f.hasta.min = f.desde.value; if (!f.hasta.value || f.hasta.value < f.desde.value) f.hasta.value = f.desde.value; };
  f.onsubmit = e => {
    e.preventDefault();
    ocupado(f.querySelector('button'), async () => {
      const { error: e2 } = await sb.from('indisponibilidad').insert({ desde: f.desde.value, hasta: f.hasta.value, motivo: f.motivo.value.trim() || null });
      if (e2) return fallo(e2, 'Fechas');
      toast('Fechas guardadas'); pintarIndisp();
    });
  };
  box.querySelector('.indisp-lista').onclick = async e => {
    const b = e.target.closest('[data-ind]');
    if (!b) return;
    b.closest('.indisp-item').classList.add('saliendo');
    const { error: e2 } = await sb.from('indisponibilidad').delete().eq('id', b.dataset.ind);
    if (e2) return fallo(e2, 'Fechas');
    setTimeout(pintarIndisp, 250);
  };
}

// =====================================================================
// NOTIFICACIONES PUSH
// =====================================================================
const PUSH_TIPOS = {
  asignacion: ['🙋', 'Cuando me asignan a un día'],
  recordatorio: ['⏰', 'Recordatorio un día antes'],
  mencion: ['💬', 'Cuando me mencionan en un chat'],
  en_vivo: ['🔴', 'Cuando empieza un en vivo donde sirvo'],
  muro: ['📣', 'Nuevas publicaciones en el muro'],
};
const PUSH_DEF = { asignacion: true, recordatorio: true, mencion: true, en_vivo: true, muro: false };
const pushSoportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64aU8 = b => { const p = '='.repeat((4 - b.length % 4) % 4); return Uint8Array.from(atob((b + p).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); };
const nombreDispositivo = () => (/iphone|ipad/i.test(navigator.userAgent) ? 'iPhone' : /android/i.test(navigator.userAgent) ? 'Android' : 'Computadora');

async function miSuscripcion() {
  if (!pushSoportado()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function activarPush() {
  if (!VAPID_PUBLIC_KEY) throw new Error('Falta configurar VAPID_PUBLIC_KEY en js/config.js');
  if (await Notification.requestPermission() !== 'granted') throw new Error('No diste permiso para notificaciones');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aU8(VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  await sb.from('push_suscripciones').delete().eq('endpoint', j.endpoint);
  const { error } = await sb.from('push_suscripciones').insert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, dispositivo: nombreDispositivo() });
  if (error) throw error;
}
async function desactivarPush() {
  const sub = await miSuscripcion();
  if (!sub) return;
  await sb.from('push_suscripciones').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
}

async function pintarNotif() {
  const box = $('#cardNotif');
  if (!box) return;
  if (st.faltaV7) { box.innerHTML = ''; return; }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let estado;
  if (!pushSoportado()) estado = ios && !standalone ? 'ios' : 'no';
  else if (Notification.permission === 'denied') estado = 'bloq';
  else estado = (await miSuscripcion().catch(() => null)) ? 'on' : 'off';
  if (!$('#cardNotif')) return;
  const prefs = { ...PUSH_DEF, ...(st.perfil.notif || {}) };
  const ETIQ = { on: 'Activas aquí', off: 'Apagadas', bloq: 'Bloqueadas', ios: 'Instala la app', no: 'No disponible' };
  box.innerHTML = `<div class="card notif">
    <div class="notif-h"><b>🔔 Notificaciones</b><span class="estado-push ${estado}">${ETIQ[estado]}</span></div>
    ${estado === 'ios' ? '<p class="ayuda">En iPhone llegan solo con la app instalada en la pantalla de inicio (iOS 16.4 o más). Instálala y vuelve aquí.</p>' : ''}
    ${estado === 'bloq' ? '<p class="ayuda">Las bloqueaste en este navegador. Permítelas en los ajustes del sitio y vuelve a abrir la app.</p>' : ''}
    ${estado === 'no' ? '<p class="ayuda">Este navegador no permite notificaciones.</p>' : ''}
    ${estado === 'off' ? '<p class="ayuda" style="margin-bottom:0">Recibe avisos aunque la app esté cerrada.</p><button class="btn prim blk" data-push="on" style="margin-top:10px">Activar en este celular</button>' : ''}
    ${'notif' in st.perfil ? `<div class="prefs">${Object.entries(PUSH_TIPOS).map(([k, [ico, txt]]) =>
      `<label class="switch"><span>${ico} ${txt}</span><input type="checkbox" data-pref="${k}" ${prefs[k] ? 'checked' : ''}><i></i></label>`).join('')}</div>` : ''}
    ${estado === 'on' ? '<div class="fila" style="margin-top:12px"><button class="btn sm" data-push="prueba">Enviar prueba</button><button class="btn sm peligro" data-push="off">Apagar aquí</button></div>' : ''}
  </div>`;
  box.onclick = async e => {
    const b = e.target.closest('[data-push]');
    if (!b) return;
    const txt = b.textContent; b.disabled = true; b.textContent = '…';
    try {
      if (b.dataset.push === 'on') { await activarPush(); toast('🔔 Notificaciones activadas'); }
      else if (b.dataset.push === 'off') { await desactivarPush(); toast('Notificaciones apagadas en este celular'); }
      else {
        const { data, error } = await sb.functions.invoke('push', { body: { tipo: 'prueba' } });
        if (error) throw error;
        toast(data?.enviados ? 'Enviada · revisa tu celular' : 'No se encontró este celular, actívalas de nuevo', !data?.enviados);
      }
    } catch (err) { fallo(err, 'Notificaciones'); }
    b.disabled = false; b.textContent = txt;
    pintarNotif();
  };
  box.onchange = async e => {
    const c = e.target.closest('[data-pref]');
    if (!c) return;
    const notif = { ...PUSH_DEF, ...(st.perfil.notif || {}), [c.dataset.pref]: c.checked };
    const { error } = await sb.from('profiles').update({ notif }).eq('id', st.uid);
    if (error) { c.checked = !c.checked; return fallo(error, 'Preferencias'); }
    st.perfil = { ...st.perfil, notif }; st.perfiles.set(st.uid, st.perfil);
  };
}
