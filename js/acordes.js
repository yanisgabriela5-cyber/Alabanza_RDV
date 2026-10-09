// Transposición y render de letras con acordes.
// Formatos soportados:
//   1) ChordPro:            [G]Cuan grande es [D]Él
//   2) Acordes sobre letra:  G          D
//                            Cuan grande es Él
//   Secciones:               "Coro:"  o  {Coro}

const SOSTENIDOS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BEMOLES    = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LATINO = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
const EXTRA = { Cb: 11, Fb: 4, 'E#': 5, 'B#': 0 };
// Tonalidades mayores que se escriben con bemoles: F, Bb, Eb, Ab, Db
const MAYORES_BEMOL = new Set([5, 10, 3, 8, 1]);

export const TONOS_MAYORES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const TONOS_MENORES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
export const TODOS_LOS_TONOS = [...TONOS_MAYORES, ...TONOS_MENORES];

export function indiceNota(n) {
  if (n in EXTRA) return EXTRA[n];
  let i = SOSTENIDOS.indexOf(n);
  if (i < 0) i = BEMOLES.indexOf(n);
  return i;
}

export function parseTono(tono) {
  const m = /^\s*([A-G][#b]?)\s*(m|min|-)?\s*$/.exec(tono || '');
  if (!m) return null;
  const idx = indiceNota(m[1]);
  return idx < 0 ? null : { idx, menor: !!m[2] };
}

export function usaBemoles(tono) {
  const t = typeof tono === 'string' ? parseTono(tono) : tono;
  if (!t) return false;
  if (t.menor && t.idx === 3) return true; // Ebm en lugar de D#m
  const mayorRelativa = t.menor ? (t.idx + 3) % 12 : t.idx;
  return MAYORES_BEMOL.has(mayorRelativa);
}

/** Semitonos para ir de un tono a otro (−5..+6). */
export function distancia(desde, hasta) {
  const a = parseTono(desde), b = parseTono(hasta);
  if (!a || !b) return 0;
  let d = (b.idx - a.idx + 12) % 12;
  if (d > 6) d -= 12;
  return d;
}

function nombreNota(idx, bemoles) {
  return (bemoles ? BEMOLES : SOSTENIDOS)[((idx % 12) + 12) % 12];
}

export function transponerTono(tono, semis) {
  const t = parseTono(tono);
  if (!t) return tono || '';
  const idx = (t.idx + semis + 120) % 12;
  const bem = usaBemoles({ idx, menor: t.menor });
  return nombreNota(idx, bem) + (t.menor ? 'm' : '');
}

const RE_ACORDE = /^([A-G][#b]?)((?:maj|min|dim|aug|sus|add|m|M|°|ø|\+|-|#|b|\d|\(|\)|\.)*)(?:\/([A-G][#b]?))?$/;

export function esAcorde(tok) {
  return RE_ACORDE.test(tok);
}

export function cifrado(nota, latino) {
  if (!latino) return nota;
  return LATINO[nota[0]] + nota.slice(1);
}

export function transponerAcorde(acorde, semis, bemoles, latino = false) {
  const m = RE_ACORDE.exec(acorde.trim());
  if (!m) return acorde;
  const [, raiz, resto, bajo] = m;
  const r = indiceNota(raiz);
  let out = cifrado(nombreNota(r + semis, bemoles), latino) + resto;
  if (bajo) out += '/' + cifrado(nombreNota(indiceNota(bajo) + semis, bemoles), latino);
  return out;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function esLineaDeAcordes(linea) {
  if (linea.includes('[')) return false;
  const toks = linea.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  // Permitir marcadores comunes como "|", "x2", "(x2)"
  const utiles = toks.filter(t => !/^(\||\(?x\d+\)?|-+)$/i.test(t));
  return utiles.length > 0 && utiles.every(esAcorde);
}

function transponerLineaDeAcordes(linea, semis, bemoles, latino) {
  // Mantiene posiciones: cada acorde arranca en la misma columna (si cabe)
  let out = '';
  const re = /\S+/g;
  let m;
  while ((m = re.exec(linea))) {
    const tok = esAcorde(m[0]) ? transponerAcorde(m[0], semis, bemoles, latino) : m[0];
    if (out.length < m.index) out += ' '.repeat(m.index - out.length);
    else if (out.length) out += ' ';
    out += tok;
  }
  return out;
}

function etiquetaSeccion(linea) {
  const t = linea.trim();
  let m = /^\{\s*(?:c|comment|soc|sot)?\s*:?\s*([^}]*)\}$/i.exec(t);
  if (m) return m[1].trim();
  if (!t.includes('[') && t.length <= 40 && /:$/.test(t) && !esLineaDeAcordes(t.slice(0, -1))) return t.slice(0, -1).trim();
  return null;
}

/**
 * Convierte la letra en HTML.
 * @param {string} texto
 * @param {object} op { semis, bemoles, acordes (mostrar), latino }
 */
export function renderLetra(texto, { semis = 0, bemoles = false, acordes = true, latino = false } = {}) {
  const lineas = String(texto || '').replace(/\r/g, '').split('\n');
  const formatoClasico = lineas.some(esLineaDeAcordes);
  const html = [];
  for (const linea of lineas) {
    if (!linea.trim()) { html.push('<div class="l-vacia"></div>'); continue; }
    const sec = etiquetaSeccion(linea);
    if (sec !== null) { html.push(`<div class="l-seccion">${esc(sec)}</div>`); continue; }

    if (esLineaDeAcordes(linea)) {
      if (acordes) html.push(`<div class="l-acordes mono">${esc(transponerLineaDeAcordes(linea, semis, bemoles, latino))}</div>`);
      continue;
    }

    if (linea.includes('[')) {
      const partes = [];
      const re = /\[([^\]]*)\]/g;
      let ultimo = 0, acorde = null, m;
      while ((m = re.exec(linea))) {
        const txt = linea.slice(ultimo, m.index);
        if (txt || acorde !== null) partes.push({ acorde, txt });
        acorde = m[1];
        ultimo = re.lastIndex;
      }
      partes.push({ acorde, txt: linea.slice(ultimo) });
      if (!acordes) {
        html.push(`<div class="l-letra">${esc(partes.map(p => p.txt).join(''))}</div>`);
        continue;
      }
      // Cada palabra es un bloque para que las líneas largas puedan saltar de renglón;
      // el acorde queda pegado a la primera palabra que le sigue.
      const seg = (ch, txt) =>
        `<span class="seg"><span class="ch">${ch ? esc(ch) : '&nbsp;'}</span><span class="ly">${txt ? esc(txt).replace(/ /g, '&nbsp;') : '&nbsp;'}</span></span>`;
      const segs = [];
      for (const p of partes) {
        const ch = p.acorde ? transponerAcorde(p.acorde, semis, bemoles, latino) : '';
        const palabras = p.txt.match(/\S*\s*/g).filter(Boolean);
        if (!palabras.length) { segs.push(seg(ch, '')); continue; }
        palabras.forEach((w, i) => segs.push(seg(i === 0 ? ch : '', w)));
      }
      html.push(`<div class="l-chordpro">${segs.join('')}</div>`);
      continue;
    }

    html.push(`<div class="l-letra${formatoClasico ? ' mono' : ''}">${esc(linea)}</div>`);
  }
  return html.join('');
}

/** Detecta el primer acorde de la letra (útil para sugerir el tono original). */
export function primerAcorde(texto) {
  const m = /\[([A-G][#b]?m?)/.exec(texto || '');
  if (m) return m[1];
  for (const l of String(texto || '').split('\n')) {
    if (esLineaDeAcordes(l)) {
      const tok = l.trim().split(/\s+/).find(esAcorde);
      const p = tok && /^([A-G][#b]?)(m(?!aj))?/.exec(tok);
      if (p) return p[1] + (p[2] || '');
    }
  }
  return null;
}
