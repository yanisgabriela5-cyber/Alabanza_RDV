// Cifrado desde audio: detecta acordes, tono y BPM en el propio celular (sin servidor ni librerías).
// Lo carga el editor de cifrado solo cuando un admin lo usa.

// ===== Análisis de audio → acordes, tono y BPM (sin librerías) =====
const NOTAS_S = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTAS_B = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const hann = n => Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));

/** Espectro de magnitudes por ventana. cb(frameIndex, mag) */
function stft(x, N, hop, cb) {
  const w = hann(N), re = new Float64Array(N), im = new Float64Array(N), mag = new Float32Array(N / 2);
  const frames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    cb(f, mag);
  }
  return frames;
}

// Plantillas: 12 mayores + 12 menores
const PLANTILLAS = [];
for (let r = 0; r < 12; r++) for (const [tipo, iv] of [['', [0, 4, 7]], ['m', [0, 3, 7]]]) {
  const t = new Float32Array(12);
  t[r] = 1; t[(r + iv[1]) % 12] = 0.9; t[(r + iv[2]) % 12] = 0.8;
  const n = Math.hypot(...t); for (let i = 0; i < 12; i++) t[i] /= n;
  PLANTILLAS.push({ raiz: r, tipo, t });
}
// Perfiles de Krumhansl para el tono
const PERF_MAY = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PERF_MEN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correl(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}

/**
 * x: Float32Array mono, sr: frecuencia de muestreo (idealmente 11025).
 * Devuelve { tono, menor, bpm, beats[], beatChroma[][], dur }
 */
async function analizar(x, sr, progreso = () => {}) {
  const pausa = () => new Promise(r => setTimeout(r, 0));
  // ---- 1. Croma (N=4096, hop=512) ----
  const N = 4096, hop = 512;
  const kMin = Math.ceil(60 * N / sr), kMax = Math.min(N / 2 - 1, Math.floor(2100 * N / sr));
  const pcDe = new Int8Array(N / 2).fill(-1);
  for (let k = kMin; k <= kMax; k++) {
    const midi = 69 + 12 * Math.log2((k * sr / N) / 440);
    if (Math.abs(midi - Math.round(midi)) < 0.4) pcDe[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const chroma = [], energia = [];
  const totalFr = Math.floor((x.length - N) / hop) + 1;
  stft(x, N, hop, (f, mag) => {
    const c = new Float32Array(12);
    let e = 0;
    for (let k = kMin; k <= kMax; k++) {
      // pico local: reduce ruido entre notas
      if (pcDe[k] >= 0 && mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) c[pcDe[k]] += Math.log1p(mag[k] * 10);
      e += mag[k];
    }
    chroma.push(c); energia.push(e);
    if (f % 400 === 0) progreso(0.05 + 0.5 * f / totalFr);
  });
  await pausa();
  const tFrame = f => (f * hop + N / 2) / sr;

  // ---- 2. Envolvente de ataques (N=1024, hop=128) ----
  const N2 = 1024, hop2 = 128;
  const onset = [];
  let prev = null;
  stft(x, N2, hop2, (f, mag) => {
    let s = 0;
    if (prev) for (let k = 1; k < N2 / 2; k++) { const d = Math.log1p(mag[k]) - Math.log1p(prev[k]); if (d > 0) s += d; }
    onset.push(s);
    prev = Float32Array.from(mag);
  });
  progreso(0.75); await pausa();
  // quitar tendencia (media móvil) y rectificar
  const fpsO = sr / hop2, ventana = Math.round(fpsO * 0.5);
  const on = onset.map((v, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - ventana); j < Math.min(onset.length, i + ventana); j++) { s += onset[j]; n++; }
    return Math.max(0, v - s / n);
  });

  // ---- 3. Tempo por autocorrelación (55–190 BPM, preferencia suave ~95) ----
  let mejor = { lag: 0, val: -Infinity };
  const lagMin = Math.round(fpsO * 60 / 190), lagMax = Math.round(fpsO * 60 / 55);
  const ac = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < on.length; i++) s += on[i] * on[i + lag];
    ac[lag] = s / (on.length - lag);
  }
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = 60 * fpsO / lag;
    const peso = Math.exp(-0.5 * (Math.log2(bpm / 95) / 0.9) ** 2);
    // reforzar con el doble del periodo
    const v = (ac[lag] + 0.5 * (ac[2 * lag] || 0)) * peso;
    if (v > mejor.val) mejor = { lag, val: v };
  }
  // refinamiento parabólico
  let lag = mejor.lag;
  const a0 = ac[lag - 1] ?? ac[lag], a1 = ac[lag], a2 = ac[lag + 1] ?? ac[lag];
  const den = a0 - 2 * a1 + a2;
  const lagF = lag + (den ? 0.5 * (a0 - a2) / den : 0);
  const periodo = lagF / fpsO;
  const bpm = Math.round(60 / periodo);

  // ---- 4. Fase de los tiempos ----
  let mejorFase = 0, mejorS = -1;
  for (let ph = 0; ph < lagF; ph += 1) {
    let s = 0;
    for (let t = ph; t < on.length; t += lagF) s += on[Math.round(t)] || 0;
    if (s > mejorS) { mejorS = s; mejorFase = ph; }
  }
  const dur = x.length / sr;
  // inicio: primer frame con energía apreciable
  const eMax = Math.max(...energia);
  let fIni = energia.findIndex(e => e > eMax * 0.08); if (fIni < 0) fIni = 0;
  const tIni = Math.max(0, tFrame(fIni) - periodo);
  const beats = [];
  for (let t = mejorFase / fpsO + (N2 / 2) / sr; t < dur; t += periodo) if (t >= tIni) beats.push(t);
  progreso(0.85); await pausa();

  // ---- 5. Croma por tiempo ----
  const beatChroma = beats.map((t, i) => {
    const t2 = beats[i + 1] ?? t + periodo;
    const c = new Float32Array(12); let n = 0, e = 0;
    for (let f = 0; f < chroma.length; f++) {
      const tf = tFrame(f);
      if (tf >= t + 0.15 * (t2 - t) && tf < t2 - 0.15 * (t2 - t)) { for (let p = 0; p < 12; p++) c[p] += chroma[f][p]; e += energia[f]; n++; }
    }
    return { c, e: n ? e / n : 0 };
  });

  // ---- 6. Tono ----
  const total = new Float32Array(12);
  chroma.forEach(c => c.forEach((v, p) => (total[p] += v)));
  let tono = { raiz: 0, menor: false, r: -2 };
  for (let r = 0; r < 12; r++) {
    const rot = Array.from({ length: 12 }, (_, i) => total[(i + r) % 12]);
    const rM = correl(rot, PERF_MAY), rm = correl(rot, PERF_MEN);
    if (rM > tono.r) tono = { raiz: r, menor: false, r: rM };
    if (rm > tono.r) tono = { raiz: r, menor: true, r: rm };
  }
  progreso(1);
  return { tono, bpm, periodo, beats, beatChroma, dur, chroma, energia, tFrame };
}

/** Acorde por tiempo con Viterbi (penaliza cambiar de acorde y premia acordes del tono). */
function acordesPorTiempo(beatChroma, tono, { cambio = 0.18 } = {}) {
  const diat = new Set();
  const esc = tono.menor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const raizRel = tono.menor ? (tono.raiz + 3) % 12 : tono.raiz;  // diatónicos del relativo mayor
  [[0, ''], [2, 'm'], [4, 'm'], [5, ''], [7, ''], [9, 'm']].forEach(([iv, t]) => diat.add(((raizRel + iv) % 12) + t));
  const es = beatChroma.map(b => b.e).sort((a, b) => a - b);
  const eMed = es[Math.floor(es.length / 2)] || 1e-9;
  const S = PLANTILLAS.length;               // + 1 = "N" (sin acorde)
  const score = beatChroma.map(({ c, e }) => {
    const n = Math.hypot(...c) || 1;
    const s = PLANTILLAS.map(p => {
      let d = 0; for (let i = 0; i < 12; i++) d += (c[i] / n) * p.t[i];
      return d + (diat.has(p.raiz + p.tipo) ? 0.06 : 0);
    });
    s.push(e < eMed * 0.3 ? 1.2 : 0.3);    // silencio
    return s;
  });
  const T = score.length; if (!T) return [];
  const dp = [Float64Array.from(score[0])], bk = [];
  for (let t = 1; t < T; t++) {
    let iMax = 0; for (let j = 1; j <= S; j++) if (dp[t - 1][j] > dp[t - 1][iMax]) iMax = j;
    const fila = new Float64Array(S + 1), b = new Int16Array(S + 1);
    for (let j = 0; j <= S; j++) {
      const quedar = dp[t - 1][j], saltar = dp[t - 1][iMax] - cambio;
      if (quedar >= saltar) { fila[j] = quedar + score[t][j]; b[j] = j; } else { fila[j] = saltar + score[t][j]; b[j] = iMax; }
    }
    dp.push(fila); bk.push(b);
  }
  let j = 0; for (let k = 1; k <= S; k++) if (dp[T - 1][k] > dp[T - 1][j]) j = k;
  const res = new Array(T); res[T - 1] = j;
  for (let t = T - 1; t > 0; t--) { j = bk[t - 1][j]; res[t - 1] = j; }
  return res.map(i => (i === S ? null : PLANTILLAS[i]));
}

function nombreAcorde(p, tono) {
  if (!p) return 'N';
  const bemoles = tono.menor ? [2, 5, 7, 0, 10, 3].includes(tono.raiz) : [5, 10, 3, 8, 1, 6].includes(tono.raiz);
  return (bemoles ? NOTAS_B : NOTAS_S)[p.raiz] + p.tipo;
}
function nombreTono(tono) { return nombreAcorde({ raiz: tono.raiz, tipo: tono.menor ? 'm' : '' }, tono); }

/** Agrupa tiempos en compases. desfase = en qué tiempo empieza el compás 1. */
function compases(acordes, beats, tono, { porCompas = 4, desfase = 0, dos = true } = {}) {
  const nom = acordes.map(a => nombreAcorde(a, tono));
  const res = [];
  const ini = ((desfase % porCompas) + porCompas) % porCompas;
  if (ini) res.push({ t: beats[0], acordes: [mayoria(nom.slice(0, ini))], parcial: true });
  for (let i = ini; i < nom.length; i += porCompas) {
    const c = nom.slice(i, i + porCompas);
    const mitad = Math.ceil(c.length / 2);
    const a = mayoria(c.slice(0, mitad)), b = mayoria(c.slice(mitad));
    const acs = dos && a !== b && c.slice(0, mitad).every(x => x === a) && c.slice(mitad).every(x => x === b) ? [a, b] : [mayoria(c)];
    res.push({ t: beats[i], acordes: acs });
  }
  // quitar silencio al inicio y al final
  while (res.length && res[0].acordes.every(x => x === 'N')) res.shift();
  while (res.length && res.at(-1).acordes.every(x => x === 'N')) res.pop();
  return res;
}
function mayoria(arr) {
  const m = new Map(); arr.forEach((v, i) => m.set(v, (m.get(v) || 0) + 1 + (i === 0 ? 0.1 : 0)));
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N';
}

/** Mejor desfase: el que hace coincidir más cambios de acorde con el inicio del compás. */
function mejorDesfase(acordes, porCompas = 4) {
  let mejor = 0, mv = -Infinity;
  for (let d = 0; d < porCompas; d++) {
    let v = 0;
    for (let i = 1; i < acordes.length; i++) if (acordes[i] !== acordes[i - 1]) v += (i - d) % porCompas === 0 ? 1 : -0.3;
    if (v > mv) { mv = v; mejor = d; }
  }
  return mejor;
}

function textoCifrado(cs, { porFila = 4, seccion = 'A' } = {}) {
  const filas = [];
  for (let i = 0; i < cs.length; i += porFila) filas.push('| ' + cs.slice(i, i + porFila).map(c => c.acordes.join(' ').replace(/\bN\b/g, 'N.C.')).join(' | ') + ' |');
  return `*${seccion}\n` + filas.join('\n');
}

const SR = 11025;
/** Lee un archivo de audio, lo pasa a mono 11 kHz y lo analiza. */
export async function analizarArchivo(file, progreso = () => {}) {
  const buf = await file.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const audio = await new Promise((ok, mal) => ctx.decodeAudioData(buf.slice(0), ok, mal));
  ctx.close?.();
  if (audio.duration > 12 * 60) throw new Error('El audio dura más de 12 minutos');
  const off = new OfflineAudioContext(1, Math.ceil(audio.duration * SR), SR);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  const x = (await off.startRendering()).getChannelData(0);
  return analizar(x, SR, progreso);
}

/** Tiempos con el tempo cambiado (0.5 = mitad, 2 = doble) y su croma. */
function beatsConTempo(r, tempo) {
  if (tempo === 1) return { beats: r.beats, bc: r.beatChroma };
  const b = r.beats;
  const beats = tempo === 0.5 ? b.filter((_, i) => i % 2 === 0)
    : b.flatMap((t, i) => [t, t + ((b[i + 1] ?? t + r.periodo) - t) / 2]);
  const bc = beats.map((t, i) => {
    const t2 = beats[i + 1] ?? t + (beats[1] - beats[0]);
    const c = new Float32Array(12); let n = 0, e = 0;
    for (let f = 0; f < r.chroma.length; f++) {
      const tf = r.tFrame(f);
      if (tf >= t + 0.15 * (t2 - t) && tf < t2 - 0.15 * (t2 - t)) { for (let p = 0; p < 12; p++) c[p] += r.chroma[f][p]; e += r.energia[f]; n++; }
    }
    return { c, e: n ? e / n : 0 };
  });
  return { beats, bc };
}

/** Arma el texto de cifrado. op: { tempo, desfase (null = automático), dos } */
export function cifradoDesdeAnalisis(r, op = {}) {
  const tempo = op.tempo || 1;
  const { beats, bc } = beatsConTempo(r, tempo);
  const ac = acordesPorTiempo(bc, r.tono, { cambio: 0.18 * (tempo === 2 ? 0.6 : 1) });
  const desfase = op.desfase ?? mejorDesfase(ac.map(a => (a ? a.raiz + a.tipo : 'N')));
  const cs = compases(ac, beats, r.tono, { desfase, dos: op.dos !== false });
  return { texto: textoCifrado(cs), desfase, bpm: Math.round(r.bpm * tempo), tono: nombreTono(r.tono), compases: cs.length };
}
