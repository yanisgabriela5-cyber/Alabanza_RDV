// Cifrado en compases (estilo iReal Pro).
// Formato de texto (lo guarda la canción en `canciones.cifrado`):
//
//   *A Verso
//   | C#m | B/D# | E | E |
//   | C#m | B/D# | E B/D# | F#m |
//   *B Coro
//   | A | B | C#m | G#m |
//
// - "*A Nombre"  inicia una sección (letra A, B, C… y nombre opcional).
// - Cada "|" separa compases. Varios acordes en un compás: separados por espacio.
// - "%" repite el compás anterior. Cada renglón empieza una fila nueva (4 compases por fila).

import { transponerAcorde, esAcorde, esLineaDeAcordes, etiquetaSeccion, aCorchetes } from './acordes.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POR_FILA = 4;

// Encabezados de sección que suelen venir sin ":" en las letras
const RE_SECCION_SUELTA = /^\(?\s*(intro|introducci[oó]n|verso|estrofa|pre-?coro|precoro|coro|estribillo|puente|interludio|instrumental|final|outro|tag|vamp|solo)(\s*\d+)?\s*\)?\s*(x\s*\d+)?\s*$/i;
const normalizar = s => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s*\d+\s*$/, '').replace(/\s*x\s*\d+$/, '').trim();

function seccionDe(linea) {
  const t = linea.trim();
  if (!t) return null;
  const sec = etiquetaSeccion(t);
  if (sec !== null) return sec;
  const m = RE_SECCION_SUELTA.exec(t);
  return m ? t.replace(/[()]/g, '').trim() : null;
}

/** Arma un borrador de cifrado desde la letra: 1 acorde = 1 compás, secciones detectadas. */
export function generarCifrado(letra) {
  const lineas = aCorchetes(String(letra || '').replace(/\r/g, '')).split('\n');
  const secciones = [];
  const letras = new Map();   // nombre normalizado -> letra de sección
  let actual = null;
  const nuevaSeccion = nombre => {
    let clave = nombre ? normalizar(nombre) : '';
    if (!clave) clave = `__${secciones.length}`;
    if (!letras.has(clave)) letras.set(clave, String.fromCharCode(65 + Math.min(letras.size, 25)));
    actual = { letra: letras.get(clave), nombre: nombre || '', acordes: [] };
    secciones.push(actual);
  };
  for (const l of lineas) {
    const sec = seccionDe(l);
    if (sec !== null) { nuevaSeccion(sec); continue; }
    const acordes = [...l.matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim()).filter(esAcorde);
    if (!acordes.length) continue;
    if (!actual) nuevaSeccion('');
    actual.acordes.push(...acordes);
  }
  return secciones.filter(s => s.acordes.length).map(s => {
    const filas = [];
    for (let i = 0; i < s.acordes.length; i += POR_FILA) filas.push('| ' + s.acordes.slice(i, i + POR_FILA).join(' | ') + ' |');
    return `*${s.letra}${s.nombre ? ' ' + s.nombre : ''}\n${filas.join('\n')}`;
  }).join('\n');
}

/** Texto → [{ letra, nombre, filas: [[ [acordes], … ]] }] */
export function parseCifrado(texto) {
  const secciones = [];
  let actual = null;
  let previo = null;
  for (const raw of String(texto || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const m = /^\*\s*([A-Za-z0-9]{1,4})\b\s*(.*)$/.exec(l);
    if (m) { actual = { letra: m[1].toUpperCase(), nombre: m[2].trim(), filas: [] }; secciones.push(actual); continue; }
    if (!actual) { actual = { letra: '', nombre: '', filas: [] }; secciones.push(actual); }
    const partes = l.includes('|') ? l.split('|') : [l];
    const compases = partes.map(p => p.trim()).filter(Boolean).map(p => {
      if (p === '%') return previo ? [...previo] : [];
      const ac = p.split(/\s+/).filter(Boolean);
      previo = ac;
      return ac;
    });
    for (let i = 0; i < compases.length; i += POR_FILA) actual.filas.push(compases.slice(i, i + POR_FILA));
  }
  return secciones.filter(s => s.filas.length);
}

/** Valida el texto: devuelve los tokens que no se reconocen como acorde. */
export function erroresCifrado(texto) {
  const malos = new Set();
  parseCifrado(texto).forEach(s => s.filas.flat(2).forEach(a => { if (!esAcorde(a) && !/^[-x/.]$/i.test(a)) malos.add(a); }));
  return [...malos];
}

// Separa un acorde ya transpuesto en raíz / calidad / bajo para dibujarlo como en iReal
function acordeHTML(ac) {
  const m = /^((?:Do|Re|Mi|Fa|Sol|La|Si|[A-G])[#b]?)(.*?)(?:\/((?:Do|Re|Mi|Fa|Sol|La|Si|[A-G])[#b]?))?$/.exec(ac);
  if (!m) return `<span class="cf-ac"><span class="cf-raiz">${esc(ac)}</span></span>`;
  const [, raiz, cal, bajo] = m;
  const alt = (n, sup) => n.replace('#', sup ? '<sup>♯</sup>' : '♯').replace(/(?<=.)b$/, sup ? '<sup>♭</sup>' : '♭');
  return `<span class="cf-ac"><span class="cf-raiz">${alt(raiz, true)}</span>${cal ? `<span class="cf-cal">${esc(cal)}</span>` : ''}${bajo ? `<span class="cf-bajo">/${alt(bajo)}</span>` : ''}</span>`;
}

/** Dibuja la grilla. op: { semis, bemoles, latino, titulo, sub } */
export function renderCifrado(texto, { semis = 0, bemoles = false, latino = false } = {}) {
  const secs = parseCifrado(texto);
  if (!secs.length) return '';
  const t = a => (esAcorde(a) ? transponerAcorde(a, semis, bemoles, latino) : a);
  return `<div class="cf">${secs.map(s => `
    <div class="cf-sec">
      ${s.letra || s.nombre ? `<div class="cf-sec-h">${s.letra ? `<span class="cf-letra">${esc(s.letra)}</span>` : ''}${s.nombre ? `<span class="cf-nombre">${esc(s.nombre)}</span>` : ''}</div>` : ''}
      ${s.filas.map(f => `<div class="cf-fila">${Array.from({ length: POR_FILA }, (_, i) => {
        const c = f[i];
        if (!c) return '<div class="cf-comp vacio"></div>';
        return `<div class="cf-comp ${c.length > 1 ? 'multi' : ''}">${c.length ? c.map(a => acordeHTML(t(a))).join('') : '<span class="cf-sim">𝄎</span>'}</div>`;
      }).join('')}</div>`).join('')}
    </div>`).join('')}</div>`;
}

export const AYUDA_CIFRADO = `*A Verso      ← sección (letra y nombre)
| C#m | B/D# | E | E |
| E B/D# | F#m | % |   ← 2 acordes en un compás · % repite
*B Coro
| A | B | C#m | G#m |`;

export { esLineaDeAcordes };
