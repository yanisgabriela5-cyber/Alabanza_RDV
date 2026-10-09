import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY, APP_NOMBRE, INSTRUMENTOS, NOTAS_TABS, REACCIONES, ROLES, ROLES_CANTO } from './config.js';
import {
  TONOS_MAYORES, TONOS_MENORES, TODOS_LOS_TONOS, parseTono, usaBemoles, distancia,
  transponerTono, renderLetra, primerAcorde, cifrado,
} from './acordes.js';

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
  seguirVivo: true,     // seguir al líder en modo en vivo
};

const LS = 'alabanza.ajustes';
const ajustes = (() => {
  const def = { latino: false, acordes: true, fuente: 18 };
  try { return { ...def, ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return def; }
})();
const guardarAjustes = () => { try { localStorage.setItem(LS, JSON.stringify(ajustes)); } catch {} };

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
  const voces = ['voz', 'coros'];
  return aprobados().sort((a, b) => (voces.includes(b.instrumento) - voces.includes(a.instrumento)) || a.nombre.localeCompare(b.nombre));
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
    $('#nav').hidden = true;
    return vistaAuth();
  }
  let { data: perfil, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (!perfil && !error) {
    await new Promise(r => setTimeout(r, 1200));
    ({ data: perfil, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
  }
  if (error) { app.innerHTML = `<div class="auth"><div class="msg err">No se pudo cargar tu perfil: ${esc(error.message)}</div><button class="btn blk" onclick="location.reload()">Reintentar</button></div>`; return; }
  st.perfil = perfil;
  if (!perfil || perfil.estado !== 'aprobado') { $('#nav').hidden = true; return vistaPendiente(); }
  await Promise.all([cargarPerfiles(), cargarTipos()]);
  $('#nav').hidden = false;
  if (!location.hash || location.hash === '#' || location.hash === '#/') location.replace('#/muro');
  else rutear();
}

async function cargarPerfiles() {
  const { data, error } = await sb.from('profiles').select('*').order('nombre');
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
    const SEL_PROG = ', setlist:setlists(id, titulo, fecha, ensayo_fecha, lugar, tipo, tipo_evento_id, asignaciones(perfil_id, rol, estado), setlist_items(orden, tono, cantante_id, cancion:canciones(titulo, tono_original)))';
    const [{ data, error }, pend, rv] = await Promise.all([
      sb.from('publicaciones')
        .select('*, comentarios(id, contenido, created_at, autor_id), reacciones(emoji, usuario_id)' + (st.faltaV2 ? '' : SEL_PROG))
        .order('fijada', { ascending: false }).order('created_at', { ascending: false })
        .range(0, st.muroLimite - 1),
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

async function comprimirImagen(file) {
  if (file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const max = 1600, r = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * r); c.height = Math.round(bmp.height * r);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
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
  const { data, error } = await sb.from('canciones').select('id, titulo, artista, tono_original').order('titulo');
  if (!ctx.vigente()) return;
  if (error) return fallo(error, 'Canciones');
  const filtro = ctx.q.get('b') || '';
  app.innerHTML = encabezado('Canciones', { sub: `${data.length} en el repertorio` }) + `
    <div class="buscador"><input id="busca" type="search" placeholder="Buscar por título o artista" value="${esc(filtro)}"></div>
    <div class="lista" id="lista"></div>
    ${esAdmin() ? `<button class="fab" data-acc="nueva" aria-label="Nueva canción">+</button>` : ''}`;
  const pintar = () => {
    const q = normalizar($('#busca').value);
    const res = data.filter(c => !q || normalizar(c.titulo + ' ' + (c.artista || '')).includes(q));
    $('#lista').innerHTML = res.map(c => `
      <a class="item" href="#/cancion/${c.id}">
        <div class="info"><b>${esc(c.titulo)}</b><small>${esc(c.artista || 'Sin artista')}</small></div>
        <span class="tono-pill">${esc(tonoTxt(c.tono_original))}</span>
      </a>`).join('') || `<div class="vacio"><span class="grande">🎵</span>${data.length ? 'Sin resultados.' : 'Aún no hay canciones.'}${!data.length && esAdmin() ? '<br>Toca <b>+</b> para agregar la primera.' : ''}</div>`;
  };
  pintar();
  app.oninput = e => { if (e.target.id === 'busca') { pintar(); history.replaceState(null, '', '#/canciones' + (e.target.value ? '?b=' + encodeURIComponent(e.target.value) : '')); } };
  app.onclick = e => { if (e.target.closest('[data-acc=nueva]')) modalCancion(null); };
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
      <label>Letra con acordes</label>
      <textarea class="letra" name="letra" spellcheck="false" placeholder="Intro:
[G] [D] [Em] [C]

Verso 1:
[G]Cuan grande es [D]Él…

Coro:
…">${esc(x.letra)}</textarea>
      <p class="ayuda">Escribe los acordes entre corchetes justo antes de la sílaba: <b>[G]Cuan grande</b>. También puedes pegar el formato con acordes en la línea de arriba. Una línea que termina en <b>:</b> (ej. <b>Coro:</b>) se muestra como sección.</p>
      <label>Video de referencia (YouTube)</label>
      <input name="video_url" type="url" inputmode="url" value="${esc(x.video_url)}" placeholder="https://youtu.be/…">
      <button class="btn prim blk" type="submit">${c ? 'Guardar cambios' : 'Crear canción'}</button>
    </form>`);
  const form = $('#fCan', body);
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
  const [rc, rn, rt, rs] = await Promise.all([
    sb.from('canciones').select('*').eq('id', id).maybeSingle(),
    sb.from('notas_cancion').select('*').eq('cancion_id', id),
    sb.from('tonos_cantante').select('*').eq('cancion_id', id),
    setId ? sb.from('setlist_items').select('id, cancion_id, cantante_id, tono, notas, orden').eq('setlist_id', setId).order('orden') : Promise.resolve({ data: null }),
  ]);
  if (!ctx.vigente()) return;
  const err = rc.error || rn.error || rt.error || rs.error;
  if (err) return fallo(err, 'Canción');
  const c = rc.data;
  if (!c) { app.innerHTML = encabezado('Canción', { atras: '#/canciones' }) + '<div class="vacio">Esta canción ya no existe.</div>'; return; }

  const notas = Object.fromEntries((rn.data || []).map(n => [n.instrumento, n]));
  const tonos = (rt.data || []).sort((a, b) => nombreDe(a.cantante_id).localeCompare(nombreDe(b.cantante_id)));
  const items = rs.data;
  const idx = items ? Math.max(0, items.findIndex((it, i) => it.cancion_id === id && (ctx.q.get('i') == null || i === +ctx.q.get('i')))) : -1;
  const itemSet = items?.[idx];
  const vivo = !!(setId && ctx.q.get('vivo') === '1' && !st.faltaV2);
  const irItem = i => { const it = items[i]; return `#/cancion/${it.cancion_id}?set=${setId}&i=${i}${it.tono ? '&tono=' + encodeURIComponent(it.tono) : ''}${vivo ? '&vivo=1' : ''}`; };

  const original = parseTono(c.tono_original) ? c.tono_original : null;
  const menor = !!parseTono(original)?.menor;
  let semis = 0;
  const pedido = ctx.q.get('tono');
  if (original && pedido && parseTono(pedido)) semis = distancia(original, pedido);
  let tabNota = NOTAS_TABS[st.perfil.instrumento] ? st.perfil.instrumento : 'general';
  let editandoNota = false;

  const tonoActual = () => (original ? transponerTono(original, semis) : null);
  const puedeTonos = () => esAdmin() || st.perfil.instrumento === 'voz' || st.perfil.instrumento === 'coros' || tonos.some(t => t.cantante_id === st.uid);

  const pintar = () => {
    const actual = tonoActual();
    const bem = actual ? usaBemoles(actual) : false;
    const meta = [
      c.artista ? `<span class="tag">${esc(c.artista)}</span>` : '',
      original ? `<span class="tag">Original: ${esc(tonoTxt(original))}</span>` : '',
      c.bpm ? `<span class="tag">${c.bpm} BPM</span>` : '',
      c.compas ? `<span class="tag">${esc(c.compas)}</span>` : '',
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
      </div>` : (esAdmin() ? `<p class="ayuda">Define el tono original (✏️) para poder guardar tonos por cantante.</p>` : '')}
      ${misNotas.map(([k, v]) => `<div class="card nota-mia"><b>📝 ${esc(k)}:</b> ${esc(v)}</div>`).join('')}
      <div class="letra ${ajustes.acordes ? '' : 'sin-acordes'}" style="--fuente-letra:${ajustes.fuente}px">
        ${c.letra ? renderLetra(c.letra, { semis, bemoles: bem, acordes: ajustes.acordes, latino: ajustes.latino }) : '<div class="vacio">Sin letra todavía.</div>'}
      </div>
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
      guardarAjustes(); $('.letra').style.setProperty('--fuente-letra', ajustes.fuente + 'px');
    }
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
    else if (acc === 'tonos') modalTonos(c, tonos, () => rutear());
    else if (acc === 'editar') modalCancion(c);
    else if (acc === 'borrar') {
      if (!confirm(`¿Eliminar "${c.titulo}"? También se borran sus notas, tonos y su lugar en los ensayos.`)) return;
      const { error } = await sb.from('canciones').delete().eq('id', id);
      if (error) return fallo(error, 'Canción');
      toast('Canción eliminada'); location.hash = '#/canciones';
    }
  };
}

function modalTonos(c, tonos, alGuardar) {
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
  form.cantante_id.onchange = precargar; precargar();
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('button'), async () => {
      const f = Object.fromEntries(new FormData(form));
      const { error } = await sb.from('tonos_cantante')
        .upsert({ cancion_id: c.id, cantante_id: f.cantante_id, tono: f.tono, notas: f.notas.trim() || null }, { onConflict: 'cancion_id,cantante_id' });
      if (error) return fallo(error, 'Tono');
      cerrarModal(); toast('Tono guardado'); alGuardar();
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
const ICON_ESTADO = { confirmado: '✅', rechazado: '❌', pendiente: '⏳' };
const SEL_DIA = '*, asignaciones(id, perfil_id, rol, estado)';
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
const tipoDe = s => st.tipos.find(t => t.id === s.tipo_evento_id)
  || (s.tipo === 'ensayo' ? { nombre: 'Ensayo', emoji: '🎹', color: '#4fc38a' } : { nombre: 'Evento', emoji: '📅', color: '#e0b458' });
const esTipoEnsayo = t => /ensayo/i.test(t?.nombre || '');

async function cargarTipos() {
  const { data, error } = await sb.from('tipos_evento').select('*').order('orden');
  st.faltaV2 = !!error;
  st.tipos = data || [];
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
          <small>${fmtCorta(a.setlist.fecha)} · ${fmtHora(a.setlist.fecha)} · ${esc(ROLES[a.rol] || a.rol)}</small></a>
        <button class="btn sm prim" data-acc="conf" data-id="${a.id}" data-estado="confirmado">✅ Puedo</button>
        <button class="btn sm" data-acc="conf" data-id="${a.id}" data-estado="rechazado">❌</button>
      </div>`).join('')}
  </div>`;
}

async function responderAsignacion(id, estado) {
  const { error } = await sb.from('asignaciones').update({ estado }).eq('id', id);
  if (error) return fallo(error, 'Confirmación');
  toast(estado === 'confirmado' ? '¡Gracias! Confirmado ✅' : 'Avisamos que no puedes ❌');
  rutear();
}

async function misPendientes() {
  if (st.faltaV2) return [];
  const { data } = await sb.from('asignaciones')
    .select('id, rol, estado, setlist:setlists(id, titulo, fecha, tipo_evento_id, tipo)')
    .eq('perfil_id', st.uid).eq('estado', 'pendiente');
  const limite = Date.now() - 12 * 3600e3;
  return (data || []).filter(a => a.setlist && new Date(a.setlist.fecha) >= limite)
    .sort((a, b) => a.setlist.fecha.localeCompare(b.setlist.fecha));
}

/** Resumen compacto de un día (para el muro y para compartir). */
function resumenDia(s, items) {
  const asig = (s.asignaciones || []).filter(a => a.estado !== 'rechazado');
  const linea = roles => roles.map(r => {
    const n = asig.filter(a => a.rol === r).map(a => esc(nombreDe(a.perfil_id)));
    return n.length ? `<span class="rs-rol">${esc(ROLES[r] || r)}:</span> ${n.join(', ')}` : '';
  }).filter(Boolean).join(' · ');
  const canto = linea(ROLES_CANTO);
  const instr = linea(Object.keys(ROLES).filter(r => !ROLES_CANTO.includes(r)));
  const its = [...(items || [])].filter(i => i.cancion).sort((a, b) => a.orden - b.orden);
  return `<div class="resumen">
    <div>📅 <b>${fmtCorta(s.fecha)}</b> · ${fmtHora(s.fecha)}${s.ensayo_fecha ? `<br>🎹 Ensayo: ${fmtCorta(s.ensayo_fecha)} · ${fmtHora(s.ensayo_fecha)}` : ''}${s.lugar ? `<br>📍 ${esc(s.lugar)}` : ''}</div>
    ${canto ? `<div class="rs-bloque"><div class="rs-t">🎤 Cantores</div>${canto}</div>` : ''}
    ${instr ? `<div class="rs-bloque"><div class="rs-t">🎸 Instrumentistas</div>${instr}</div>` : ''}
    ${its.length ? `<div class="rs-bloque"><div class="rs-t">🎵 Canciones</div><ol>${its.map(i =>
      `<li>${esc(i.cancion.titulo)} — <b class="tono-txt">${esc(tonoTxt(i.tono || i.cancion.tono_original))}</b>${i.cantante_id ? ` <small>(${esc(nombreDe(i.cantante_id))})</small>` : ''}</li>`).join('')}</ol></div>` : ''}
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
    sb.from('setlists').select(SEL_DIA).or(`and(fecha.gte.${a},fecha.lt.${b}),and(ensayo_fecha.gte.${a},ensayo_fecha.lt.${b})`).order('fecha'),
    sb.from('setlists').select(SEL_DIA).gte('fecha', isoSinMs(new Date(Date.now() - 12 * 3600e3))).order('fecha').limit(40),
    misPendientes(),
  ]);
  if (!ctx.vigente()) return;
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
function modalAsignar(s, rolInicial) {
  let rol = rolInicial || 'dirige';
  let asig = [...(s.asignaciones || [])];
  const relevante = p => (ROLES_CANTO.includes(rol) ? ['voz', 'coros'].includes(p.instrumento) : p.instrumento === rol);
  const pintar = () => {
    const gente = aprobados().sort((a, b) => relevante(b) - relevante(a) || a.nombre.localeCompare(b.nombre));
    const corte = gente.findIndex(p => !relevante(p));
    const body = abrirModal('Equipo del día', `
      <p class="ayuda" style="margin-top:0">${esc(s.titulo)} · ${fmtCorta(s.fecha)} ${fmtHora(s.fecha)}</p>
      <div class="segmentado">${Object.entries(ROLES).map(([k, v]) => {
        const n = asig.filter(a => a.rol === k).length;
        return `<button type="button" data-rol="${k}" class="${k === rol ? 'activo' : ''}">${esc(v)}${n ? ` (${n})` : ''}</button>`;
      }).join('')}</div>
      <form id="fAsig"><div class="lista-check">
        ${gente.map((p, i) => {
          const actual = asig.find(a => a.perfil_id === p.id && a.rol === rol);
          const otros = asig.filter(a => a.perfil_id === p.id && a.rol !== rol).map(a => ROLES[a.rol]).join(', ');
          return `${i === corte && corte > 0 ? '<div class="sep-check">Otros integrantes</div>' : ''}
            <label class="check fila-check"><input type="checkbox" name="p" value="${p.id}" ${actual ? 'checked' : ''}>
            <span><b>${esc(p.nombre)}</b> <small>${esc(INSTRUMENTOS[p.instrumento] || '')}${otros ? ' · ya en: ' + esc(otros) : ''}</small></span>
            ${actual ? `<span title="${actual.estado}">${ICON_ESTADO[actual.estado]}</span>` : ''}</label>`;
        }).join('')}
      </div>
      <button class="btn prim blk" type="submit">Guardar ${esc(ROLES[rol])}</button></form>
      <button class="btn blk" data-cerrar>Listo</button>`);
    body.querySelectorAll('[data-rol]').forEach(b => (b.onclick = () => { rol = b.dataset.rol; pintar(); }));
    const form = $('#fAsig', body);
    form.onsubmit = e => {
      e.preventDefault();
      ocupado(form.querySelector('[type=submit]'), async () => {
        const quiero = new Set(new FormData(form).getAll('p'));
        const actuales = asig.filter(a => a.rol === rol);
        const quitar = actuales.filter(a => !quiero.has(a.perfil_id)).map(a => a.id);
        const agregar = [...quiero].filter(pid => !actuales.some(a => a.perfil_id === pid))
          .map(pid => ({ setlist_id: s.id, perfil_id: pid, rol }));
        if (quitar.length) { const { error } = await sb.from('asignaciones').delete().in('id', quitar); if (error) return fallo(error, 'Equipo'); }
        if (agregar.length) { const { error } = await sb.from('asignaciones').insert(agregar); if (error) return fallo(error, 'Equipo'); }
        const { data } = await sb.from('asignaciones').select('id, perfil_id, rol, estado').eq('setlist_id', s.id);
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
  const { data, error } = await sb.from('setlists').select(SEL_DIA + ', setlist_items(id)')
    .gte('fecha', isoSinMs(ini)).lt('fecha', isoSinMs(fin)).order('fecha');
  if (!ctx.vigente()) return;
  if (error) return fallo(error, 'Planificación');
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
    ${data.length ? `<div class="tabla-wrap"><table class="plan">
      <thead><tr><th>Día</th>${cols.map(c => `<th>${esc(ROLES[c])}</th>`).join('')}<th>🎵</th></tr></thead>
      <tbody>${data.map(s => {
        const t = tipoDe(s);
        return `<tr><th style="border-left:3px solid ${esc(t.color)}"><a href="#/dia/${s.id}">${esc(t.emoji)} ${fmtCorta(s.fecha)}</a><small>${fmtHora(s.fecha)}</small></th>
          ${cols.map(c => {
            const as = s.asignaciones.filter(a => a.rol === c);
            return `<td class="${esAdmin() ? 'editable' : ''}" data-acc="celda" data-id="${s.id}" data-rol="${c}">${as.map(a =>
              `<span class="p ${a.estado}" title="${a.estado}">${esc(nombreCorto(a.perfil_id))}</span>`).join('') || '<span class="vacio-c">—</span>'}</td>`;
          }).join('')}
          <td>${s.setlist_items.length || '—'}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="ayuda">✅ confirmado · ⏳ <span class="p pendiente" style="padding:0 4px">pendiente</span> · <span class="p rechazado" style="padding:0 4px">no puede</span>${esAdmin() ? ' · Toca una celda para asignar.' : ''}</p>`
      : `<div class="vacio"><span class="grande">📋</span>No hay días este mes.${esAdmin() ? '<br>Usa <b>Generar mes</b> en la Agenda.' : ''}</div>`}
    ${data.length ? `<div class="seccion-t">Participación del mes</div>
      <div class="card" style="font-size:14px">${[...conteo.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${esc(nombreDe(id))} <b>${n}</b>`).join(' · ') || 'Nadie asignado aún.'}
      ${sinAsignar.length ? `<p class="ayuda" style="margin-bottom:0">Sin asignar: ${sinAsignar.map(p => esc(p.nombre)).join(', ')}</p>` : ''}</div>` : ''}`;

  app.onclick = e => {
    const el = e.target.closest('[data-acc=celda]');
    if (!el || !esAdmin() || e.target.closest('a')) return;
    const s = data.find(x => x.id === el.dataset.id);
    modalAsignar(s, el.dataset.rol);
  };
}

// ---------- vista: un día ----------
async function vistaDia(ctx) {
  cargando('Día', { atras: '#/agenda' });
  const [rs, ri, rv] = await Promise.all([
    sb.from('setlists').select(st.faltaV2 ? '*' : SEL_DIA).eq('id', ctx.id).maybeSingle(),
    sb.from('setlist_items').select('*, cancion:canciones(id, titulo, artista, tono_original)').eq('setlist_id', ctx.id).order('orden'),
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

  const grupo = (titulo, roles) => {
    const as = s.asignaciones.filter(a => roles.includes(a.rol)).sort((a, b) => ordenRol(a.rol) - ordenRol(b.rol));
    return `<div class="seccion-t">${titulo}</div>` + (as.length
      ? `<div class="card equipo-dia">${as.map(a => `<div class="eq-fila ${a.estado}">
          <span class="eq-rol">${esc(ROLES[a.rol] || a.rol)}</span><b>${esc(nombreDe(a.perfil_id))}</b><span title="${a.estado}">${ICON_ESTADO[a.estado]}</span></div>`).join('')}</div>`
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
      <div><b>🙋 Te toca:</b> ${mios.map(a => esc(ROLES[a.rol] || a.rol)).join(', ')}</div>
      <div class="fila" style="margin-top:10px">
        <button class="btn ${mios.every(a => a.estado === 'confirmado') ? 'prim' : ''}" data-acc="conf-mio" data-estado="confirmado">✅ Puedo</button>
        <button class="btn ${mios.every(a => a.estado === 'rechazado') ? 'peligro' : ''}" data-acc="conf-mio" data-estado="rechazado">❌ No puedo</button>
      </div></div>` : ''}
    ${vivo ? `<div class="card vivo-banner"><span class="punto-vivo"></span><div class="info"><b>En vivo ahora</b><small>Canción ${vivo.indice + 1} de ${items.length}</small></div>
        <button class="btn prim sm" data-acc="vivo-unirse">Unirme</button>
        ${esAdmin() ? '<button class="btn sm" data-acc="vivo-fin">Terminar</button>' : ''}</div>`
      : esAdmin() && items.length && !st.faltaV2 ? `<button class="btn blk" data-acc="vivo-iniciar" style="margin:0 0 12px">🔴 Iniciar en vivo</button>` : ''}
    ${st.faltaV2 ? '' : `${grupo('🎤 Cantores', ROLES_CANTO)}
      ${grupo('🎸 Instrumentistas', Object.keys(ROLES).filter(r => !ROLES_CANTO.includes(r)))}
      ${esAdmin() ? '<button class="btn sm" data-acc="asignar">👥 Asignar equipo</button>' : ''}`}
    <div class="seccion-t" style="display:flex;justify-content:space-between;align-items:center">
      <span>🎵 Repertorio (${items.length})</span>
    </div>
    <div class="lista">
      ${items.map((it, i) => `
      <div class="item set-item ${vivo && vivo.indice === i ? 'en-vivo' : ''}" data-acc="abrir" data-i="${i}">
        <span class="num">${i + 1}</span>
        <div class="info"><b>${esc(it.cancion.titulo)}</b><small>${it.cantante_id ? '🎤 ' + esc(nombreDe(it.cantante_id)) : 'Sin cantante asignado'}${it.notas ? ' · ' + esc(it.notas) : ''}</small></div>
        <span class="tono-pill">${esc(tonoTxt(it.tono || it.cancion.tono_original))}</span>
        ${esAdmin() ? `<div class="orden">
          <button data-acc="subir" data-i="${i}" aria-label="Subir" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button data-acc="item" data-i="${i}" aria-label="Editar">✏️</button>
          <button data-acc="bajar" data-i="${i}" aria-label="Bajar" ${i === items.length - 1 ? 'disabled' : ''}>▼</button>
        </div>` : ''}
      </div>`).join('') || `<div class="vacio"><span class="grande">🎶</span>Todavía no hay canciones asignadas.</div>`}
    </div>
    ${esAdmin() ? `<button class="btn prim blk" data-acc="agregar">+ Agregar canción</button>` : ''}
    <div class="fila" style="margin-top:12px">
      ${esAdmin() && !st.faltaV2 ? '<button class="btn" data-acc="publicar">📣 Publicar en el muro</button>' : ''}
      <button class="btn" data-acc="compartir">📤 WhatsApp</button>
    </div>
    ${esAdmin() ? `<button class="btn peligro blk" data-acc="borrar" style="margin-top:28px">Eliminar día</button>` : ''}`;

  // Si alguien inicia/termina el en vivo, refrescar
  if (!st.faltaV2) {
    const canal = sb.channel('dia-' + s.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'en_vivo', filter: `setlist_id=eq.${s.id}` }, () => ctx.vigente() && rutear())
      .subscribe();
    st.limpiar.push(() => sb.removeChannel(canal));
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
      if (acc === 'abrir') irCancion(i, !!vivo);
      else if (acc === 'subir' || acc === 'bajar') {
        const j = acc === 'subir' ? i - 1 : i + 1;
        const orden = items.map(x => x.id);
        [orden[i], orden[j]] = [orden[j], orden[i]];
        const res = await Promise.all(orden.map((idItem, k) => sb.from('setlist_items').update({ orden: k }).eq('id', idItem)));
        const er = res.find(r => r.error); if (er) throw er.error;
        rutear();
      }
      else if (acc === 'item') modalItem(s, items, it);
      else if (acc === 'agregar') modalItem(s, items, null);
      else if (acc === 'editar') modalDia(s);
      else if (acc === 'asignar') modalAsignar(s);
      else if (acc === 'compartir') compartirDia(s, items);
      else if (acc === 'publicar') modalPublicarDia(s);
      else if (acc === 'conf-mio') {
        const { error } = await sb.from('asignaciones').update({ estado: el.dataset.estado }).in('id', mios.map(a => a.id));
        if (error) throw error;
        toast(el.dataset.estado === 'confirmado' ? '¡Gracias! Confirmado ✅' : 'Avisamos que no puedes ❌'); rutear();
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
  const [rc, rt] = await Promise.all([
    sb.from('canciones').select('id, titulo, artista, tono_original').order('titulo'),
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
      <select name="cancion_id" required>${it ? '' : '<option value="">Elige…</option>'}${canciones.map(c =>
        `<option value="${c.id}" ${c.id === it?.cancion_id ? 'selected' : ''}>${esc(c.titulo)}${c.artista ? ' — ' + esc(c.artista) : ''}</option>`).join('')}</select>
      <div class="fila">
        <div><label>Cantante</label><select name="cantante_id"><option value="">Sin asignar</option>${lista.map(p =>
          `<option value="${p.id}" ${p.id === it?.cantante_id ? 'selected' : ''}>${delDia.has(p.id) ? '★ ' : ''}${esc(p.nombre)}</option>`).join('')}</select></div>
        <div><label>Tono</label><select name="tono">${opcionesTono(it?.tono || '', TODOS_LOS_TONOS, 'Original')}</select></div>
      </div>
      <p class="ayuda" id="ayudaTono"></p>
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
  };
  form.cancion_id.onchange = sugerir;
  form.cantante_id.onchange = sugerir;
  if (!it) sugerir();

  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = Object.fromEntries(new FormData(form));
      const datos = { cancion_id: f.cancion_id, cantante_id: f.cantante_id || null, tono: f.tono || null, notas: f.notas.trim() || null };
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
    const { error } = await sb.from('setlist_items').delete().eq('id', it.id);
    if (error) return fallo(error, 'Repertorio');
    cerrarModal(); toast('Quitada del repertorio'); rutear();
  };
}

async function compartirDia(s, items) {
  const t = tipoDe(s);
  const asig = (s.asignaciones || []).filter(a => a.estado !== 'rechazado').sort((a, b) => ordenRol(a.rol) - ordenRol(b.rol));
  const porRol = roles => roles.map(r => {
    const n = asig.filter(a => a.rol === r).map(a => nombreDe(a.perfil_id));
    return n.length ? `• ${ROLES[r]}: ${n.join(', ')}` : null;
  }).filter(Boolean);
  const canto = porRol(ROLES_CANTO), instr = porRol(Object.keys(ROLES).filter(r => !ROLES_CANTO.includes(r)));
  const txt = [
    `${t.emoji} *${s.titulo}*`,
    `📅 ${fmtFechaLarga(s.fecha)} · ${fmtHora(s.fecha)}`,
    s.ensayo_fecha ? `🎹 Ensayo: ${fmtFechaLarga(s.ensayo_fecha)} · ${fmtHora(s.ensayo_fecha)}` : null,
    s.lugar ? `📍 ${s.lugar}` : null,
    canto.length ? `\n🎤 *Cantores*\n${canto.join('\n')}` : null,
    instr.length ? `\n🎸 *Instrumentistas*\n${instr.join('\n')}` : null,
    items.length ? `\n🎵 *Canciones*\n${items.map((it, i) => `${i + 1}. ${it.cancion.titulo} — ${tonoTxt(it.tono || it.cancion.tono_original)}${it.cantante_id ? ` (${nombreDe(it.cantante_id)})` : ''}`).join('\n')}` : null,
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
      <button class="btn sm" data-acc="aprobar" data-id="${p.id}">Reactivar</button></div>`).join('')}</div>` : ''}`;

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
        <button class="btn blk" id="mAdmin">${p.rol === 'admin' ? 'Quitar administrador' : '⭐ Hacer administrador'}</button>
        <button class="btn peligro blk" id="mBloq">Desactivar acceso</button>`);
      $('#mGuardar', body).onclick = () => actualizar(p.id, { instrumento: $('#mInstr', body).value }, 'Guardado');
      $('#mAdmin', body).onclick = () => actualizar(p.id, { rol: p.rol === 'admin' ? 'miembro' : 'admin' }, 'Rol actualizado');
      $('#mBloq', body).onclick = () => confirm(`¿Desactivar a ${p.nombre}?`) && actualizar(p.id, { estado: 'bloqueado' }, 'Desactivado');
    }
  };
}

// =====================================================================
// PERFIL
// =====================================================================
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); st.instalarEvt = e; });

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
      <label class="check" style="margin-top:0"><input type="checkbox" id="chkLatino" ${ajustes.latino ? 'checked' : ''}> Mostrar acordes en cifrado latino (Do, Re, Mi…)</label>
    </div>
    ${!standalone ? `<div class="card instalar">
      <p>📲 ${ios ? 'Para instalar en iPhone: abre en <b>Safari</b>, toca <b>Compartir</b> ⬆️ y luego <b>"Agregar a inicio"</b>.' : 'Instala la app en tu celular para abrirla como cualquier otra.'}</p>
      ${!ios ? `<button class="btn sm prim" id="bInstalar">Instalar</button>` : ''}
    </div>` : ''}
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
  $('#bClave').onclick = modalNuevaClave;
  $('#bSalir').onclick = async () => { await sb.auth.signOut(); location.hash = ''; };
  const bi = $('#bInstalar');
  if (bi) bi.onclick = async () => {
    if (st.instalarEvt) { st.instalarEvt.prompt(); st.instalarEvt = null; }
    else toast('Usa el menú ⋮ del navegador → "Instalar app" o "Agregar a pantalla principal"');
  };
}
