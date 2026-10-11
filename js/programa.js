// Vista pública de solo lectura (sin usuario): programa.html?k=CODIGO
// Muestra días, quién canta y canciones (autor, video y letra sin acordes).
// Los datos vienen de funciones de Supabase que validan el código (ver supabase/007_programa_publico.sql).
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { esLineaDeAcordes } from './acordes.js';
import { seccionDe } from './cifrado.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const token = new URLSearchParams(location.search).get('k') || '';
const pg = $('#pg');
const RITMOS = { rapida: '⚡ Rápidas', lenta: '🕊️ Lentas', '': '🎵 Otras' };
const ORDEN = { rapida: 0, lenta: 1, '': 2 };
const pad = n => String(n).padStart(2, '0');
const claveMes = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
let mes = new URLSearchParams(location.search).get('mes') || claveMes(new Date());
const letras = new Map();

async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.message || `Error ${r.status}`);
  return j;
}

function toast(t) {
  const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 2200);
}

const mayus = t => t.charAt(0).toUpperCase() + t.slice(1);
const fmtCuando = iso => mayus(new Date(iso).toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long' }));
const fmtHora = iso => new Date(iso).toLocaleTimeString('es-PA', { hour: 'numeric', minute: '2-digit' });
const nombreMes = m => { const [y, mm] = m.split('-').map(Number); return mayus(new Date(y, mm - 1, 1).toLocaleDateString('es-PA', { month: 'long', year: 'numeric' })); };
const moverMes = (m, n) => { const [y, mm] = m.split('-').map(Number); return claveMes(new Date(y, mm - 1 + n, 1)); };

/** Letra sin acordes: quita líneas de acordes, [acordes] en línea y deja los títulos de sección. */
function letraLimpia(letra) {
  const out = [];
  for (const raw of String(letra || '').replace(/\r/g, '').split('\n')) {
    if (/^\s*tono\s*:/i.test(raw) || esLineaDeAcordes(raw)) continue;
    const sec = seccionDe(raw);
    if (sec !== null) {
      if (out[out.length - 1] === '') out.pop();
      if (out.length && out[out.length - 1].sec !== undefined) out.pop();   // sección sin letra (p. ej. Intro instrumental)
      out.push({ sec }); continue;
    }
    const t = raw.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trimEnd();
    if (!t.trim() && (!out.length || out[out.length - 1] === '' || out[out.length - 1].sec)) continue;
    out.push(t.trim() ? t.trim() : '');
  }
  while (out.length && (out[out.length - 1] === '' || out[out.length - 1].sec !== undefined)) out.pop();
  return out;
}
const letraHTML = l => l.map(x => (x.sec !== undefined ? `<span class="sec">${esc(x.sec)}</span>` : esc(x))).join('\n').replace(/<\/span>\n/g, '</span>');
const letraTexto = l => l.map(x => (x.sec !== undefined ? `\n[${x.sec}]` : x)).join('\n').trim();

function htmlDia(d, ahora, proximoId) {
  const t = d.tipo || { nombre: d.titulo, emoji: '📅', color: '#e0b458' };
  const dir = d.voces.filter(v => v.dirige).map(v => esc(v.nombre));
  const voz = d.voces.filter(v => !v.dirige).map(v => esc(v.nombre));
  const cans = [...d.canciones].map((c, i) => ({ ...c, i, ritmo: c.ritmo || '' }));
  const conRitmo = cans.some(c => c.ritmo);
  if (conRitmo) cans.sort((a, b) => ORDEN[a.ritmo] - ORDEN[b.ritmo] || a.i - b.i);
  return `<div class="card pg-dia ${new Date(d.fecha) < ahora && d.id !== proximoId ? 'pasado' : ''} ${d.id === proximoId ? 'proximo' : ''}"
      id="d-${d.id}" style="border-left-color:${esc(t.color || '#e0b458')}">
    <h2>${esc(t.emoji || '📅')} ${esc(d.titulo || t.nombre)} ${d.id === proximoId ? '<span class="tag ok">Próximo</span>' : ''}</h2>
    <div class="cuando">${esc(fmtCuando(d.fecha))} · ${esc(fmtHora(d.fecha))}${d.lugar ? ' · 📍 ' + esc(d.lugar) : ''}</div>
    ${dir.length || voz.length ? `<div class="pg-voces">🎤 ${dir.length ? `<b>👑 Dirige:</b> ${dir.join(', ')}` : ''}${dir.length && voz.length ? ' · ' : ''}${voz.length ? `<b>Voces:</b> ${voz.join(', ')}` : ''}</div>` : ''}
    ${cans.length ? cans.map((c, k) => `${conRitmo && (k === 0 || cans[k - 1].ritmo !== c.ritmo) ? `<div class="pg-sub">${RITMOS[c.ritmo]}</div>` : ''}
      <div class="pg-can">
        <div class="pg-can-top">
          <span class="n">${k + 1}</span>
          <div class="info"><b>${esc(c.titulo)}</b><small>${esc(c.artista || 'Autor no indicado')}${c.cantante ? ' · 🎤 ' + esc(c.cantante) : ''}</small></div>
          <div class="acc">
            ${c.video && /^https?:\/\//i.test(c.video) ? `<a class="btn sm" href="${esc(c.video)}" target="_blank" rel="noopener">▶ Video</a>` : ''}
            <button class="btn sm" data-letra="${esc(c.id)}">📄 Letra</button>
          </div>
        </div>
        <div class="pg-letra" data-caja="${esc(c.id)}" hidden></div>
      </div>`).join('') : '<p class="ayuda">Aún no hay canciones para este día.</p>'}
  </div>`;
}

async function cargar() {
  if (!token) { pg.innerHTML = '<div class="pg-vacio">🔒 Falta el código de acceso en el link.<br>Pide el link correcto a un administrador.</div>'; return; }
  const [y, m] = mes.split('-').map(Number);
  const desde = new Date(y, m - 1, 1), hasta = new Date(y, m, 1);
  pg.innerHTML = `
    <div class="pg-head"><img src="icons/logo.png" alt=""><div><h1>Programa de Alabanza</h1><small>Roca de Vida Panamá · solo lectura</small></div></div>
    <div class="pg-mes">
      <button class="btn-ico" data-mes="-1" aria-label="Mes anterior">‹</button>
      <b>${esc(nombreMes(mes))}</b>
      <button class="btn-ico" data-mes="1" aria-label="Mes siguiente">›</button>
    </div>
    <div id="dias"><div class="pg-vacio">Cargando…</div></div>`;
  let dias;
  try { dias = await rpc('programa_publico', { p_token: token, p_desde: desde.toISOString(), p_hasta: hasta.toISOString() }); }
  catch (e) {
    $('#dias').innerHTML = `<div class="pg-vacio">🔒 ${/no válido|desactivado/i.test(e.message) ? 'Este link ya no es válido. Pide uno nuevo a un administrador.' : 'No se pudo cargar el programa. Revisa tu conexión.'}</div>`;
    return;
  }
  const ahora = new Date(Date.now() - 3 * 3600e3);   // un día sigue como "próximo" hasta 3 h después de empezar
  const proximo = dias.find(d => new Date(d.fecha) >= ahora);
  $('#dias').innerHTML = dias.length ? dias.map(d => htmlDia(d, ahora, proximo?.id)).join('') : '<div class="pg-vacio">📅 No hay días programados este mes.</div>';
  if (proximo && mes === claveMes(new Date())) document.getElementById('d-' + proximo.id)?.scrollIntoView({ block: 'start' });
}

pg.addEventListener('click', async e => {
  const bm = e.target.closest('[data-mes]');
  if (bm) {
    mes = moverMes(mes, +bm.dataset.mes);
    history.replaceState(null, '', `?k=${encodeURIComponent(token)}&mes=${mes}`);
    return cargar();
  }
  const bc = e.target.closest('[data-copiar]');
  if (bc) {
    try { await navigator.clipboard.writeText(letraTexto(letras.get(bc.dataset.copiar) || [])); toast('Letra copiada'); }
    catch { toast('No se pudo copiar'); }
    return;
  }
  const bl = e.target.closest('[data-letra]');
  if (!bl) return;
  const id = bl.dataset.letra;
  const caja = bl.closest('.pg-can').querySelector('[data-caja]');
  if (!caja.hidden) { caja.hidden = true; return; }
  caja.hidden = false;
  if (!letras.has(id)) {
    caja.textContent = 'Cargando…';
    try { letras.set(id, letraLimpia(await rpc('letra_publica', { p_token: token, p_cancion: id }))); }
    catch { caja.textContent = 'No se pudo cargar la letra.'; return; }
  }
  const l = letras.get(id);
  caja.innerHTML = l.length
    ? `${letraHTML(l)}\n<button class="btn sm" data-copiar="${esc(id)}" style="margin-top:8px">📋 Copiar letra</button>`
    : 'Esta canción no tiene letra cargada.';
});

cargar();
