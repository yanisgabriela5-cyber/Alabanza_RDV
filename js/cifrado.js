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

import { transponerAcorde, esAcorde, esLineaDeAcordes, etiquetaSeccion, aCorchetes, cifrado as notaLatina } from './acordes.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POR_FILA = 4;

// Encabezados de sección que suelen venir sin ":" en las letras
const RE_SECCION_SUELTA = /^\(?\s*(intro|introducci[oó]n|verso|estrofa|pre-?coro|precoro|coro|estribillo|puente|interludio|instrumental|final|outro|tag|vamp|solo)(\s*\d+)?\s*\)?\s*(x\s*\d+)?\s*$/i;
const normalizar = s => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s*\d+\s*$/, '').replace(/\s*x\s*\d+$/, '').trim();

export function seccionDe(linea) {
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

/**
 * Texto → [{ letra, nombre, filas: [[ compás, … ]] }]
 * compás = { ac: [acordes], izq, der, casilla, marcas: [], texto, repite, tsig }
 *   izq: 'rep' ({) | 'doble' ([)          der: 'rep' (}) | 'doble' (]) | 'fin' (Z)
 *   casilla: 1|2|3 (N1, N2…)   marcas: 'coda' (Q), 'segno' (S), 'fermata' (f)
 *   repite: 1 (% o x) | 2 (r: repite 2 compases)   tsig: '3/4' (T34)   texto: <D.C. al Coda>
 */
export function parseCifrado(texto) {
  const secciones = [];
  let actual = null;
  const todos = [];            // todos los compases, para % / x / r
  for (const raw of String(texto || '').replace(/\r/g, '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const m = /^\*\s*([A-Za-z0-9]{1,4})\b\s*(.*)$/.exec(l);
    if (m) { actual = { letra: m[1].toUpperCase(), nombre: m[2].trim(), filas: [] }; secciones.push(actual); continue; }
    if (!actual) { actual = { letra: '', nombre: '', filas: [] }; secciones.push(actual); }
    const linea = [];
    let cur = null, izqPend = null;
    const nuevo = () => (cur ??= { ac: [], izq: izqPend, der: null, casilla: null, marcas: [], texto: '', repite: 0, tsig: '' });
    const cerrar = der => {
      const destino = cur && (cur.ac.length || cur.repite || cur.casilla || cur.marcas.length || cur.texto || cur.tsig) ? cur : null;
      if (destino) { if (der) destino.der = der; linea.push(destino); todos.push(destino); }
      else if (der) { const ult = linea.at(-1) || todos.at(-1); if (ult) ult.der = der; }
      cur = null; izqPend = null;
    };
    const toks = l.match(/<[^>]*>|[{}\[\]|]|N[1-3](?=\S)|T\d\d(?=\S)|[^\s{}\[\]|<>,]+/g) || [];
    for (const t of toks) {
      if (t === '|') cerrar();
      else if (t === '{' || t === '[') { cerrar(); izqPend = t === '{' ? 'rep' : 'doble'; }
      else if (t === '}') cerrar('rep');
      else if (t === ']') cerrar('doble');
      else if (t === 'Z') cerrar('fin');
      else if (t[0] === '<') nuevo().texto = t.slice(1, -1).trim();
      else if (/^N[1-3]$/.test(t)) nuevo().casilla = +t[1];
      else if (t === 'Q') nuevo().marcas.push('coda');
      else if (t === 'S') nuevo().marcas.push('segno');
      else if (t === 'f') nuevo().marcas.push('fermata');
      else if (/^T\d\d$/.test(t)) nuevo().tsig = `${t[1] === '1' && t[2] === '2' ? '12/8' : t[1] + '/' + t[2]}`;
      else if (t === '%' || t === 'x') { const c = nuevo(); c.repite = 1; c.ac = [...(todos.at(-1)?.ac || [])]; }
      else if (t === 'r') {
        // repite los dos compases anteriores: ocupa este y el siguiente
        const a = todos.at(-2)?.ac || [], b = todos.at(-1)?.ac || [];
        const c = nuevo(); c.repite = 2; c.ac = [...a]; cerrar();
        const d = nuevo(); d.repite = 3; d.ac = [...b];
      }
      else if (t === 'n' || /^N\.?C\.?$/i.test(t)) nuevo().ac.push('N.C.');
      else if (t === 'p') nuevo().ac.push('/');
      else nuevo().ac.push(t);
    }
    cerrar();
    for (let i = 0; i < linea.length; i += POR_FILA) actual.filas.push(linea.slice(i, i + POR_FILA));
  }
  return secciones.filter(s => s.filas.length);
}

/** Valida el texto: devuelve los tokens que no se reconocen como acorde. */
export function erroresCifrado(texto) {
  const malos = new Set();
  parseCifrado(texto).forEach(s => s.filas.flat().forEach(c => c.ac.forEach(a => {
    if (!esAcorde(a) && a !== 'N.C.' && !/^[-x/.]$/i.test(a)) malos.add(a);
  })));
  return [...malos];
}

// Separa un acorde ya transpuesto en raíz / calidad / bajo para dibujarlo como en iReal
function acordeHTML(ac) {
  if (ac === 'N.C.') return '<span class="cf-ac cf-nc">N.C.</span>';
  if (ac === '/') return '<span class="cf-ac cf-pausa">/</span>';
  const m = /^((?:Do|Re|Mi|Fa|Sol|La|Si|[A-G])[#b]?)(.*?)(?:\/((?:Do|Re|Mi|Fa|Sol|La|Si|[A-G])[#b]?))?$/.exec(ac);
  if (!m) return `<span class="cf-ac"><span class="cf-raiz">${esc(ac)}</span></span>`;
  const [, raiz, cal, bajo] = m;
  const alt = (n, sup) => n.replace('#', sup ? '<sup>♯</sup>' : '♯').replace(/(?<=.)b$/, sup ? '<sup>♭</sup>' : '♭');
  return `<span class="cf-ac"><span class="cf-raiz">${alt(raiz, true)}</span>${cal ? `<span class="cf-cal">${esc(cal)}</span>` : ''}${bajo ? `<span class="cf-bajo">/${alt(bajo)}</span>` : ''}</span>`;
}

const MARCA = { coda: '⊕', segno: '§', fermata: '⌒' };

/** Dibuja la grilla. op: { semis, bemoles, latino } */
export function renderCifrado(texto, { semis = 0, bemoles = false, latino = false } = {}) {
  const secs = parseCifrado(texto);
  if (!secs.length) return '';
  // Sin transponer se respeta cómo está escrito (Bb sigue siendo Bb, no A#)
  const t = a => (!esAcorde(a) ? a
    : semis ? transponerAcorde(a, semis, bemoles, latino)
    : latino ? a.replace(/^([A-G])/, m => notaLatina(m, true)).replace(/\/([A-G])/, (_, m) => '/' + notaLatina(m, true)) : a);
  const comp = c => {
    if (!c) return '<div class="cf-comp vacio"></div>';
    // en pantallas angostas los acordes largos se achican para no salirse del compás
    const largo = c.repite ? 0 : c.ac.reduce((n, a) => n + a.length, 0) + (c.ac.length - 1) * 2;
    const cls = ['cf-comp', c.ac.length > 1 && !c.repite ? 'multi' : '', largo > 11 ? 'apretado' : largo > 7 ? 'largo' : '', c.izq ? 'izq-' + c.izq : '', c.der ? 'der-' + c.der : '', c.casilla ? 'casilla' : ''].filter(Boolean).join(' ');
    const centro = c.repite === 1 ? '<span class="cf-sim" title="Repite el compás anterior">𝄎</span>'
      : c.repite === 2 ? '<span class="cf-sim cf-sim2" title="Repite los dos compases anteriores">𝄏</span>'
      : c.repite === 3 ? ''
      : c.ac.length ? c.ac.map(a => acordeHTML(t(a))).join('') : '';
    return `<div class="${cls}">
      ${c.izq ? `<span class="cf-bar izq ${c.izq}"></span>` : ''}${c.der ? `<span class="cf-bar der ${c.der}"></span>` : ''}
      ${c.casilla ? `<span class="cf-casilla">${c.casilla}.</span>` : ''}
      ${c.marcas.length ? `<span class="cf-marca">${c.marcas.map(m => MARCA[m]).join('')}</span>` : ''}
      ${c.tsig ? `<span class="cf-tsig">${esc(c.tsig.split('/')[0])}<br>${esc(c.tsig.split('/')[1])}</span>` : ''}
      ${centro}
      ${c.texto ? `<span class="cf-texto">${esc(c.texto)}</span>` : ''}
    </div>`;
  };
  return `<div class="cf">${secs.map(s => `
    <div class="cf-sec">
      ${s.letra || s.nombre ? `<div class="cf-sec-h">${s.letra ? `<span class="cf-letra">${esc(s.letra)}</span>` : ''}${s.nombre ? `<span class="cf-nombre">${esc(s.nombre)}</span>` : ''}</div>` : ''}
      ${s.filas.map(f => `<div class="cf-fila">${Array.from({ length: POR_FILA }, (_, i) => comp(f[i])).join('')}</div>`).join('')}
    </div>`).join('')}</div>`;
}

// =====================================================================
// Importar desde iReal Pro (links irealb:// o irealbook://)
// =====================================================================
function desordenar50(s) {
  const r = s.split('');
  for (let i = 0; i < 5; i++) { r[49 - i] = s[i]; r[i] = s[49 - i]; }
  for (let i = 10; i < 24; i++) { r[49 - i] = s[i]; r[i] = s[49 - i]; }
  return r.join('');
}
function desofuscar(s) {
  let r = '';
  while (s.length > 51) { r += desordenar50(s.slice(0, 50)); s = s.slice(50); }
  r += s;
  return r.replace(/Kcl/g, '| x').replace(/LZ/g, ' |').replace(/XyQ/g, '   ');
}

/** Acorde de iReal → acorde de la app (C^7 → Cmaj7, C-7 → Cm7, Ch7 → Cm7b5, Co7 → Cdim7) */
export function acordeDeIreal(a) {
  const m = /^([A-GW][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(a);
  if (!m) return a;
  let [, raiz, cal, bajo] = m;
  cal = cal
    .replace(/^-\^7?/, 'mmaj7').replace(/^-/, 'm')
    .replace(/^\^(?=\d)/, 'maj').replace(/^\^$/, 'maj7')
    .replace(/^h7?/, 'm7b5').replace(/^o7/, 'dim7').replace(/^o/, 'dim')
    .replace(/\^/g, 'maj');
  return raiz + cal + (bajo ? '/' + bajo : '');
}

/** Música de iReal → texto de cifrado de la app */
function musicaAApp(musica) {
  // quitar acordes alternativos (entre paréntesis) y marcas de formato que no usamos
  let m = musica.replace(/\([^)]*\)/g, ' ').replace(/,/g, ' ')
    // "*" pegado a la raíz del acorde (D*m) no es sección: se quita para que quede Dm
    .replace(/([A-G][#b]?)\*(?=[a-z0-9^+\-])/g, '$1')
    // códigos de posición de iReal dentro de comentarios: <*69x3> → <x3>
    .replace(/<\s*\*\d{2}\s*/g, '<');
  const toks = m.match(/<[^>]*>|\*[A-Za-z](?![a-z])|[{}\[\]|]|T\d\d|N[1-3]|[^\s{}\[\]|<>*]+/g) || [];
  const NOM = { i: 'I Intro', v: 'V Verso', V: 'V Verso', A: 'A', B: 'B', C: 'C', D: 'D' };
  const lineas = [];
  let linea = [];
  const corte = () => { if (linea.length) lineas.push(linea.join(' ').replace(/\s+/g, ' ').trim()); linea = []; };
  for (let t of toks) {
    if (t[0] === '*') {
      // la barra de inicio y el compás (T44) que vienen antes de la sección pasan a la línea nueva
      const pasa = [];
      while (linea.length && /^([{\[]|T\d\d)$/.test(linea.at(-1))) pasa.unshift(linea.pop());
      corte(); lineas.push('*' + (NOM[t[1]] || t[1].toUpperCase())); linea = pasa; continue;
    }
    if (t === 'Y' || t === 'YY' || t === 'YYY' || t === 'U') { corte(); continue; }
    // una doble barra de inicio a mitad de línea abre un bloque nuevo ("a parte A", "Final"…): renglón nuevo
    if (t === '[' && linea.some(x => x !== '{' && !/^T\d\d$/.test(x))) corte();
    if (t[0] === '<' || /^[{}\[\]|]$/.test(t) || /^T\d\d$/.test(t) || /^N[1-3]$/.test(t) || ['Q', 'S', 'f', 'x', 'r', 'n', 'p', 'Z'].includes(t)) { linea.push(t); continue; }
    // quitar prefijos de tamaño (s = chico, l = grande) pegados al acorde
    t = t.replace(/^[sl](?=[A-GWnpx])/, '');
    if (!t || t === 's' || t === 'l') continue;
    if (/^W/.test(t)) { linea.push('/'); continue; }       // raíz invisible: se muestra como pausa
    linea.push(acordeDeIreal(t));
  }
  corte();
  // renglones de 4 compases (cuenta separadores) para que se lea como en iReal
  return lineas.map(l => (l[0] === '*' ? l : l)).join('\n')
    .replace(/\|\s*\|/g, '|').replace(/^\s*\|\s*/gm, '| ');
}

/**
 * Lee un link de iReal Pro y devuelve las canciones:
 * [{ titulo, compositor, estilo, tono, bpm, cifrado }]
 */
export function leerIreal(link) {
  let s = String(link || '').trim();
  const m = /(irealb(?:ook)?):\/\/(.+)$/s.exec(s);
  if (!m) throw new Error('No es un link de iReal Pro (debe empezar con irealb://)');
  const nuevo = m[1] === 'irealb';
  try { s = decodeURIComponent(m[2]); } catch { s = m[2]; }
  const partes = s.split('===').filter(Boolean);
  if (nuevo && partes.length > 1) partes.pop();            // el último es el nombre de la lista
  return partes.map(p => {
    const f = p.split('=');
    let titulo, compositor, estilo, tono, musica, bpm;
    if (nuevo) {
      // Título=Compositor=(vacío)=Estilo=Tono=(vacío)=Música=Acompañamiento=BPM=Repeticiones
      [titulo, compositor, , estilo, tono, , musica, , bpm] = f;
      if (musica?.startsWith('1r34LbKcu7')) musica = desofuscar(musica.slice(10));
    } else {
      [titulo, compositor, estilo, tono, , musica] = f;
    }
    if (!musica) return null;
    return {
      titulo: (titulo || '').trim(),
      compositor: (compositor || '').trim(),
      estilo: (estilo || '').trim(),
      tono: (tono || '').replace(/-$/, 'm').trim(),
      bpm: +bpm || null,
      cifrado: musicaAApp(musica),
    };
  }).filter(Boolean);
}

export const AYUDA_CIFRADO = `*A Verso         ← sección (letra y nombre)
{ C#m | B/D# | E | % }    ← { } repetición · % repite compás
| E B/D# | F#m | N1 E | B }   ← 2 acordes · N1 1.ª casilla
| N2 E | % | S A | Q B Z   ← S segno · Q coda · Z final
*B Coro
[ A | B | <x2> C#m | n ]   ← [ ] doble barra · <texto> · n = N.C.`;

export { esLineaDeAcordes };
