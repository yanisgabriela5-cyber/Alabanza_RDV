import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY, APP_NOMBRE, INSTRUMENTOS, NOTAS_TABS, REACCIONES } from './config.js';
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
  await cargarPerfiles();
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
        if (error) msg(/already registered/i.test(error.message) ? 'Ese correo ya tiene cuenta. Usa "Entrar".' : error.message);
        else if (!data.session) vistaAuth('login', { txt: 'Te enviamos un correo para confirmar tu cuenta. Después entra aquí; un administrador debe aprobarte.' });
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(f.email.trim(), { redirectTo: baseUrl() });
        if (error) msg(error.message); else msg('Si el correo está registrado, te llegará un enlace para cambiar la contraseña.', false);
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
  ensayos: vistaEnsayos,
  ensayo: vistaEnsayo,
  equipo: vistaEquipo,
  perfil: vistaPerfil,
};
const TAB_DE = { cancion: 'canciones', ensayo: 'ensayos', perfil: 'equipo' };

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
    const { data, error } = await sb.from('publicaciones')
      .select('*, comentarios(id, contenido, created_at, autor_id), reacciones(emoji, usuario_id)')
      .order('fijada', { ascending: false }).order('created_at', { ascending: false })
      .range(0, st.muroLimite - 1);
    if (!ctx.vigente()) return;
    if (error) return fallo(error, 'Muro');
    const posts = data.map(tarjetaPost).join('');
    app.innerHTML = encabezado('Muro', { sub: 'Roca de Vida Panamá' }) + (posts || `
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
  ].join(' ');
  const cuerpo = p.tipo === 'frase'
    ? `<p class="post-frase">${esc(p.contenido)}</p>`
    : `${p.titulo ? `<h3 class="post-titulo">${esc(p.titulo)}</h3>` : ''}${p.contenido ? `<p class="post-texto">${esc(p.contenido)}</p>` : ''}`;
  const img = urlSegura(p.media_url) ? `<img class="post-img" src="${esc(p.media_url)}" alt="" loading="lazy">` : '';
  return `
  <article class="card ${p.fijada ? 'fijada' : ''} ${p.tipo === 'comunicado' ? 'comunicado' : ''}">
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
        <button data-acc="editar" data-id="${p.id}">✏️</button>
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
    app.innerHTML = encabezado(c.titulo, { atras: setId ? `#/ensayo/${setId}` : '#/canciones', derecha }) + `
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
      const ir = i => { const it = items[i]; return `#/cancion/${it.cancion_id}?set=${setId}&i=${i}${it.tono ? '&tono=' + encodeURIComponent(it.tono) : ''}`; };
      nav.innerHTML = `<div>
        <a class="btn-ico" ${idx > 0 ? `href="${ir(idx - 1)}"` : 'style="opacity:.3"'} aria-label="Anterior">‹</a>
        <span>${idx + 1} / ${items.length}</span>
        <a class="btn-ico" ${idx < items.length - 1 ? `href="${ir(idx + 1)}"` : 'style="opacity:.3"'} aria-label="Siguiente">›</a></div>`;
      document.body.appendChild(nav);
      st.limpiar.push(() => nav.remove());
    }
  };
  pintar();

  app.onchange = e => {
    if (e.target.id === 'selTono') { semis = distancia(original, e.target.value); pintar(); }
  };
  app.onclick = async e => {
    const el = e.target.closest('[data-acc]');
    if (!el) return;
    const acc = el.dataset.acc;
    if (acc === 'subir') { semis = ((semis + 1 + 6) % 12 + 12) % 12 - 6; pintar(); }
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
// ENSAYOS / EVENTOS
// =====================================================================
async function vistaEnsayos(ctx) {
  cargando('Ensayos y eventos');
  const desde = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const [prox, pas] = await Promise.all([
    sb.from('setlists').select('*, setlist_items(id)').gte('fecha', desde).order('fecha'),
    sb.from('setlists').select('*, setlist_items(id)').lt('fecha', desde).order('fecha', { ascending: false }).limit(15),
  ]);
  if (!ctx.vigente()) return;
  if (prox.error || pas.error) return fallo(prox.error || pas.error, 'Ensayos');
  const fila = s => {
    const d = new Date(s.fecha);
    return `<a class="item" href="#/ensayo/${s.id}">
      <div class="fecha-box"><small>${d.toLocaleDateString('es-PA', { month: 'short' }).replace('.', '')}</small><b>${d.getDate()}</b></div>
      <div class="info"><b>${esc(s.titulo)}</b><small>${s.tipo === 'evento' ? '🎤 Evento' : '🎹 Ensayo'} · ${d.toLocaleDateString('es-PA', { weekday: 'short' })} ${fmtHora(s.fecha)}${s.lugar ? ' · ' + esc(s.lugar) : ''}</small></div>
      <span class="tag">${s.setlist_items.length} 🎵</span></a>`;
  };
  app.innerHTML = encabezado('Ensayos y eventos') + `
    <div class="seccion-t" style="margin-top:4px">Próximos</div>
    <div class="lista">${prox.data.map(fila).join('') || `<div class="vacio"><span class="grande">📅</span>No hay ensayos programados.</div>`}</div>
    ${pas.data.length ? `<div class="seccion-t">Anteriores</div><div class="lista">${pas.data.map(fila).join('')}</div>` : ''}
    ${esAdmin() ? `<button class="fab" data-acc="nuevo" aria-label="Nuevo ensayo">+</button>` : ''}`;
  app.onclick = e => { if (e.target.closest('[data-acc=nuevo]')) modalSetlist(null); };
}

function modalSetlist(s) {
  const x = s || { tipo: 'ensayo' };
  const body = abrirModal(s ? 'Editar' : 'Nuevo ensayo o evento', `
    <form id="fSet">
      <div class="fila">
        <div><label>Tipo</label><select name="tipo"><option value="ensayo" ${x.tipo === 'ensayo' ? 'selected' : ''}>🎹 Ensayo</option><option value="evento" ${x.tipo === 'evento' ? 'selected' : ''}>🎤 Evento / servicio</option></select></div>
        <div><label>Fecha y hora</label><input name="fecha" type="datetime-local" required value="${x.fecha ? aLocalInput(x.fecha) : ''}"></div>
      </div>
      <label>Título</label><input name="titulo" required maxlength="120" placeholder="Ej: Ensayo general, Servicio domingo" value="${esc(x.titulo)}">
      <label>Lugar</label><input name="lugar" maxlength="120" value="${esc(x.lugar)}">
      <label>Notas</label><textarea name="notas" maxlength="2000" placeholder="Llegar 30 min antes, vestimenta…">${esc(x.notas)}</textarea>
      <button class="btn prim blk" type="submit">${s ? 'Guardar' : 'Crear'}</button>
    </form>`);
  const form = $('#fSet', body);
  form.onsubmit = e => {
    e.preventDefault();
    ocupado(form.querySelector('[type=submit]'), async () => {
      const f = Object.fromEntries(new FormData(form));
      const datos = { tipo: f.tipo, titulo: f.titulo.trim(), fecha: new Date(f.fecha).toISOString(), lugar: f.lugar.trim() || null, notas: f.notas.trim() || null };
      const { data, error } = s
        ? await sb.from('setlists').update(datos).eq('id', s.id).select('id').single()
        : await sb.from('setlists').insert({ ...datos, creado_por: st.uid }).select('id').single();
      if (error) return fallo(error, 'Ensayo');
      cerrarModal(); toast('Guardado');
      if (s) rutear(); else location.hash = '#/ensayo/' + data.id;
    });
  };
}

async function vistaEnsayo(ctx) {
  cargando('Ensayo', { atras: '#/ensayos' });
  const [rs, ri] = await Promise.all([
    sb.from('setlists').select('*').eq('id', ctx.id).maybeSingle(),
    sb.from('setlist_items').select('*, cancion:canciones(id, titulo, artista, tono_original)').eq('setlist_id', ctx.id).order('orden'),
  ]);
  if (!ctx.vigente()) return;
  if (rs.error || ri.error) return fallo(rs.error || ri.error, 'Ensayo');
  const s = rs.data;
  if (!s) { app.innerHTML = encabezado('Ensayo', { atras: '#/ensayos' }) + '<div class="vacio">Este ensayo ya no existe.</div>'; return; }
  const items = ri.data.filter(i => i.cancion);

  const derecha = esAdmin() ? `<button class="btn-ico" data-acc="editar" aria-label="Editar">✏️</button>` : '';
  app.innerHTML = encabezado(s.titulo, { atras: '#/ensayos', sub: s.tipo === 'evento' ? 'Evento' : 'Ensayo', derecha }) + `
    <div class="card">
      <div style="font-weight:700;text-transform:capitalize">📅 ${esc(fmtFechaLarga(s.fecha))} · ${esc(fmtHora(s.fecha))}</div>
      ${s.lugar ? `<div style="margin-top:4px;color:var(--texto-2)">📍 ${esc(s.lugar)}</div>` : ''}
      ${s.notas ? `<p class="post-texto" style="margin-top:10px">${esc(s.notas)}</p>` : ''}
    </div>
    <div class="seccion-t" style="display:flex;justify-content:space-between;align-items:center">
      <span>Repertorio (${items.length})</span>
      ${items.length ? `<button class="btn sm" data-acc="compartir">📤 Compartir</button>` : ''}
    </div>
    <div class="lista">
      ${items.map((it, i) => `
      <div class="item set-item" data-acc="abrir" data-i="${i}">
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
    ${esAdmin() ? `<button class="btn prim blk" data-acc="agregar">+ Agregar canción</button>
      <button class="btn peligro blk" data-acc="borrar" style="margin-top:28px">Eliminar ${s.tipo}</button>` : ''}`;

  app.onclick = async e => {
    const el = e.target.closest('[data-acc]');
    if (!el) return;
    const acc = el.dataset.acc, i = +el.dataset.i, it = items[i];
    if (acc === 'abrir') {
      location.hash = `#/cancion/${it.cancion_id}?set=${s.id}&i=${i}${it.tono ? '&tono=' + encodeURIComponent(it.tono) : ''}`;
    } else if (acc === 'subir' || acc === 'bajar') {
      e.stopPropagation();
      const j = acc === 'subir' ? i - 1 : i + 1;
      const orden = items.map((x, k) => x.id);
      [orden[i], orden[j]] = [orden[j], orden[i]];
      const res = await Promise.all(orden.map((idItem, k) => sb.from('setlist_items').update({ orden: k }).eq('id', idItem)));
      const er = res.find(r => r.error); if (er) return fallo(er.error, 'Orden');
      rutear();
    } else if (acc === 'item') { e.stopPropagation(); modalItem(s, items, it); }
    else if (acc === 'agregar') modalItem(s, items, null);
    else if (acc === 'editar') modalSetlist(s);
    else if (acc === 'compartir') compartirSetlist(s, items);
    else if (acc === 'borrar') {
      if (!confirm(`¿Eliminar "${s.titulo}" y su repertorio?`)) return;
      const { error } = await sb.from('setlists').delete().eq('id', s.id);
      if (error) return fallo(error, 'Ensayo');
      toast('Eliminado'); location.hash = '#/ensayos';
    }
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
  const body = abrirModal(it ? 'Editar canción del repertorio' : 'Agregar canción', `
    <form id="fItem">
      <label>Canción</label>
      <select name="cancion_id" required>${it ? '' : '<option value="">Elige…</option>'}${canciones.map(c =>
        `<option value="${c.id}" ${c.id === it?.cancion_id ? 'selected' : ''}>${esc(c.titulo)}${c.artista ? ' — ' + esc(c.artista) : ''}</option>`).join('')}</select>
      <div class="fila">
        <div><label>Cantante</label><select name="cantante_id"><option value="">Sin asignar</option>${cantantes().map(p =>
          `<option value="${p.id}" ${p.id === it?.cantante_id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></div>
        <div><label>Tono</label><select name="tono">${opcionesTono(it?.tono || '', TODOS_LOS_TONOS, 'Original')}</select></div>
      </div>
      <p class="ayuda" id="ayudaTono"></p>
      <label>Nota para este ${s.tipo} (opcional)</label><input name="notas" maxlength="200" value="${esc(it?.notas)}" placeholder="Ej: solo coro, versión corta">
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
  if (!it) sugerir(); else $('#ayudaTono', body).textContent = '';

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

async function compartirSetlist(s, items) {
  const txt = [
    `*${s.titulo}*`,
    `📅 ${fmtFechaLarga(s.fecha)} · ${fmtHora(s.fecha)}${s.lugar ? `\n📍 ${s.lugar}` : ''}`,
    '',
    ...items.map((it, i) => `${i + 1}. ${it.cancion.titulo} — ${tonoTxt(it.tono || it.cancion.tono_original)}${it.cantante_id ? ` (${nombreDe(it.cantante_id)})` : ''}`),
    s.notas ? `\n📝 ${s.notas}` : '',
    `\n${baseUrl()}#/ensayo/${s.id}`,
  ].join('\n');
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
