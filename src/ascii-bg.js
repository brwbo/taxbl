// ASCII-art background effect, Canvas2D. Reimplementation of the 21st.dev "All about the Benjamins" recipe.
// Pipeline per frame: draw source -> background layer -> sample cell grid -> tone adjust -> draw cells per renderMode
//   -> tint overlay -> post effects (vignette, scanLines, chromatic, bloom, filmGrain, glitch, pixelate, halftone, filmDust)
// Source can be an <img>, <video>, or canvas. Animation styles: flicker, wave, pulse, shimmer, ripple.

export const DEFAULT_PARAMS = {
  renderMode: 'dither', bgMode: 'solid', bgColor: '#08040f', bgBlur: 12, bgOpacity: 90,
  cellSize: 14, coverage: 96, invert: false, styleBlend: 'source-over', charSet: 'binary', customChars: '',
  brightness: 0, contrast: 115, edgeEmphasis: 40, density: 0,
  tint: '#00ff66', tintOpacity: 45, overlayBlend: 'overlay', saturation: 100, grayscale: 0,
  blurType: 'off', blurAmount: 35,
  pfx: {
    vignette: { enabled: true, intensity: 38 }, scanLines: { enabled: true, intensity: 28 },
    chromatic: { enabled: true, intensity: 40 }, bloom: { enabled: true, intensity: 60 },
    filmGrain: { enabled: true, intensity: 40 }, glitch: { enabled: true, intensity: 20 },
    pixelate: { enabled: false, intensity: 15 }, halftone: { enabled: false, intensity: 20 }, filmDust: { enabled: false, intensity: 20 },
  },
  animated: true, animStyle: 'flicker', animSpeed: { enabled: true, intensity: 100 }, animIntensity: { enabled: true, intensity: 60 },
  fgColor: '#ffffff', maxDpr: 1.5, shiftX: 0, shiftY: 0, // fraction of the canvas to shift the subject by
};

const CHARSETS = {
  binary: '01', ascii: ' .:-=+*#%@', blocks: ' ░▒▓█', hex: '0123456789ABCDEF', braille: '⠀⠁⠃⠇⠏⠟⠿⡿⣿', matrix: 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ0123456789',
};
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map((r) => r.map((v) => (v + 0.5) / 16));

function hash(x, y, seed = 0) { // deterministic 0..1 per cell
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177; h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}
function hexToRgb(hex) { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function clamp(v, a = 0, b = 255) { return v < a ? a : v > b ? b : v; }
function deepMerge(a, b) { const o = { ...a }; for (const k in b) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? deepMerge(a[k] || {}, b[k]) : b[k]; return o; }

export function mountAscii(canvas, source, userParams = {}) {
  const P = deepMerge(DEFAULT_PARAMS, userParams);
  const ctx = canvas.getContext('2d', { alpha: false });
  const sampler = document.createElement('canvas');
  const sctx = sampler.getContext('2d', { willReadFrequently: true });
  const layer = document.createElement('canvas'); // cells drawn here before post effects
  const lctx = layer.getContext('2d');
  const grain = makeGrain(160);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0, running = false, t0 = performance.now(), W = 0, H = 0, cols = 0, rows = 0, dpr = 1;
  let glitchUntil = 0, glitchSlices = [];

  function resize() {
    dpr = Math.min(P.maxDpr, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; layer.width = W; layer.height = H; }
    const cell = P.cellSize * dpr;
    cols = Math.ceil(W / cell); rows = Math.ceil(H / cell);
    sampler.width = cols; sampler.height = rows;
  }

  function sourceReady() {
    if (!source) return false;
    if (source instanceof HTMLVideoElement) return source.readyState >= 2 && source.videoWidth > 0;
    if (source instanceof HTMLImageElement) return source.complete && source.naturalWidth > 0;
    return source.width > 0;
  }

  function coverDraw(c, sw, sh, dw, dh) { // object-fit: cover, zoomed enough that a shifted subject still covers the frame
    const zoom = 1 + Math.abs(P.shiftX || 0) * 2 + Math.abs(P.shiftY || 0) * 2;
    const s = Math.max(dw / sw, dh / sh) * zoom; const w = sw * s, h = sh * s;
    c.drawImage(source, (dw - w) / 2 + dw * (P.shiftX || 0), (dh - h) / 2 + dh * (P.shiftY || 0), w, h);
  }

  function sample() {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    sctx.imageSmoothingEnabled = true;
    coverDraw(sctx, sw, sh, cols, rows);
    return sctx.getImageData(0, 0, cols, rows).data;
  }

  function tone(r, g, b) {
    const br = P.brightness * 2.55, ct = P.contrast / 100;
    r = (r - 128) * ct + 128 + br; g = (g - 128) * ct + 128 + br; b = (b - 128) * ct + 128 + br;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const s = P.saturation / 100;
    r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
    if (P.grayscale) { const k = P.grayscale / 100; r = r + (l - r) * k; g = g + (l - g) * k; b = b + (l - b) * k; }
    return [clamp(r), clamp(g), clamp(b), clamp(l) / 255];
  }

  function animOffset(cx, cy, t) {
    if (!P.animated || reduced) return 0;
    const speed = (P.animSpeed.enabled ? P.animSpeed.intensity : 50) / 100;
    const amp = (P.animIntensity.enabled ? P.animIntensity.intensity : 50) / 100;
    const tt = t * 0.001 * (0.4 + speed * 2.2);
    switch (P.animStyle) {
      case 'wave': return Math.sin(cx * 0.35 + tt * 2) * 0.25 * amp;
      case 'pulse': return Math.sin(tt * 2.5) * 0.2 * amp;
      case 'shimmer': return (hash(cx, cy, Math.floor(tt * 6)) - 0.5) * 0.35 * amp;
      case 'ripple': { const dx = cx - cols / 2, dy = cy - rows / 2; return Math.sin(Math.sqrt(dx * dx + dy * dy) * 0.4 - tt * 3) * 0.22 * amp; }
      default: { // flicker: most cells steady, a scattering jump each frame
        const f = hash(cx, cy, Math.floor(tt * 14));
        return f > 1 - 0.18 * amp ? (hash(cy, cx, Math.floor(tt * 14)) - 0.5) * 0.9 * amp : 0;
      }
    }
  }

  function drawBackground() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = P.bgColor; ctx.fillRect(0, 0, W, H);
    if (P.bgMode === 'photo' || P.bgMode === 'blur') {
      const sw = source.videoWidth || source.naturalWidth || source.width, sh = source.videoHeight || source.naturalHeight || source.height;
      ctx.save(); ctx.globalAlpha = P.bgOpacity / 100;
      if (P.bgMode === 'blur') ctx.filter = `blur(${P.bgBlur * dpr}px)`;
      coverDraw(ctx, sw, sh, W, H); ctx.restore();
    }
  }

  function drawCells(data, t) {
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, W, H);
    const cell = P.cellSize * dpr, cov = P.coverage / 100;
    const chars = P.customChars || CHARSETS[P.charSet] || CHARSETS.ascii;
    const fg = hexToRgb(P.fgColor);
    const edge = P.edgeEmphasis / 100;
    lctx.font = `${Math.round(cell * 0.95)}px ui-monospace, Menlo, monospace`;
    lctx.textAlign = 'center'; lctx.textBaseline = 'middle';
    const lum = new Float32Array(cols * rows);
    const col = new Uint8ClampedArray(cols * rows * 3);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4; const [r, g, b, l] = tone(data[i], data[i + 1], data[i + 2]);
      lum[y * cols + x] = l; col[(y * cols + x) * 3] = r; col[(y * cols + x) * 3 + 1] = g; col[(y * cols + x) * 3 + 2] = b;
    }
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (hash(x, y, 7) > cov) continue;
      const k = y * cols + x;
      let l = lum[k];
      if (edge > 0) { // gradient magnitude against neighbours
        const gx = (lum[y * cols + Math.min(cols - 1, x + 1)] - lum[y * cols + Math.max(0, x - 1)]);
        const gy = (lum[Math.min(rows - 1, y + 1) * cols + x] - lum[Math.max(0, y - 1) * cols + x]);
        l = clamp(l + Math.sqrt(gx * gx + gy * gy) * edge * 1.6, 0, 1);
      }
      l = clamp(l + animOffset(x, y, t), 0, 1);
      if (P.invert) l = 1 - l;
      const px = x * cell, py = y * cell;
      const r = col[k * 3], g = col[k * 3 + 1], b = col[k * 3 + 2];
      const color = P.grayscale >= 100 || P.renderMode === 'matrix' ? null : `rgb(${r},${g},${b})`;
      drawCell(px, py, cell, l, color || `rgb(${fg[0]},${fg[1]},${fg[2]})`, chars, x, y, t);
    }
  }

  function drawCell(px, py, cell, l, color, chars, x, y, t) {
    const c = lctx; c.fillStyle = color; c.strokeStyle = color;
    switch (P.renderMode) {
      case 'dither': { // Bayer-thresholded 2x2 sub-blocks per cell
        const sub = cell / 2; const bx = x * 2, by = y * 2;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
          const th = BAYER4[(by + j) & 3][(bx + i) & 3];
          if (l > th) c.fillRect(px + i * sub, py + j * sub, sub - 0.5 * dpr, sub - 0.5 * dpr);
        }
        break;
      }
      case 'characters': case 'hexdump': case 'braille': {
        const set = P.renderMode === 'hexdump' ? CHARSETS.hex : P.renderMode === 'braille' ? CHARSETS.braille : chars;
        const ch = set[Math.min(set.length - 1, Math.floor(l * set.length))];
        c.globalAlpha = 0.25 + l * 0.75; c.fillText(ch, px + cell / 2, py + cell / 2); c.globalAlpha = 1; break;
      }
      case 'matrix': {
        const set = CHARSETS.matrix; const tt = t * 0.0012; const drop = (hash(x, 0, 3) * 40 + tt * (4 + hash(x, 1, 3) * 6)) % (rows + 12);
        const d = y - drop; if (d > 0 || d < -12) break;
        const head = d > -1.2; c.fillStyle = head ? '#d8ffe4' : `rgba(0,255,102,${(1 + d / 12) * (0.3 + l * 0.7)})`;
        c.fillText(set[Math.floor(hash(x, y, Math.floor(tt * 3)) * set.length)], px + cell / 2, py + cell / 2); break;
      }
      case 'pixel': case 'mosaic': { const s = cell * (0.3 + l * 0.7); c.fillRect(px + (cell - s) / 2, py + (cell - s) / 2, s, s); break; }
      case 'dots': case 'bubbles': { const rr = (cell / 2) * (0.15 + l * 0.85); c.beginPath(); c.arc(px + cell / 2, py + cell / 2, rr, 0, Math.PI * 2); c.fill(); break; }
      case 'halfblocks': { const h = cell / 2; c.globalAlpha = l; c.fillRect(px, py, cell - dpr, h); c.globalAlpha = clamp(l * 1.25, 0, 1); c.fillRect(px, py + h, cell - dpr, h); c.globalAlpha = 1; break; }
      case 'lines': { c.lineWidth = Math.max(1, l * cell * 0.5); c.beginPath(); c.moveTo(px, py + cell / 2); c.lineTo(px + cell * l, py + cell / 2); c.stroke(); break; }
      case 'diagonal': case 'hatch': { c.lineWidth = dpr; const n = Math.round(l * 4); for (let i = 0; i < n; i++) { const o = (i + 1) * cell / (n + 1); c.beginPath(); c.moveTo(px, py + o); c.lineTo(px + o, py); c.stroke(); } break; }
      case 'cross': { const s = cell * l * 0.5; c.lineWidth = dpr; c.beginPath(); c.moveTo(px + cell / 2 - s, py + cell / 2); c.lineTo(px + cell / 2 + s, py + cell / 2); c.moveTo(px + cell / 2, py + cell / 2 - s); c.lineTo(px + cell / 2, py + cell / 2 + s); c.stroke(); break; }
      case 'diamond': { const s = cell * l * 0.5; c.beginPath(); c.moveTo(px + cell / 2, py + cell / 2 - s); c.lineTo(px + cell / 2 + s, py + cell / 2); c.lineTo(px + cell / 2, py + cell / 2 + s); c.lineTo(px + cell / 2 - s, py + cell / 2); c.fill(); break; }
      case 'rings': { c.lineWidth = dpr; c.beginPath(); c.arc(px + cell / 2, py + cell / 2, (cell / 2) * l, 0, Math.PI * 2); c.stroke(); break; }
      default: { const ch = chars[Math.min(chars.length - 1, Math.floor(l * chars.length))]; c.globalAlpha = 0.25 + l * 0.75; c.fillText(ch, px + cell / 2, py + cell / 2); c.globalAlpha = 1; }
    }
  }

  function composite(t) {
    ctx.globalCompositeOperation = P.styleBlend || 'source-over';
    ctx.drawImage(layer, 0, 0);
    // tint overlay
    if (P.tintOpacity > 0) { ctx.save(); ctx.globalCompositeOperation = P.overlayBlend; ctx.globalAlpha = P.tintOpacity / 100; ctx.fillStyle = P.tint; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    const fx = P.pfx;
    if (fx.bloom?.enabled) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = fx.bloom.intensity / 100 * 0.55; ctx.filter = `blur(${6 * dpr}px)`; ctx.drawImage(layer, 0, 0); ctx.restore(); }
    if (fx.chromatic?.enabled) {
      const o = fx.chromatic.intensity / 100 * 3 * dpr; ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.22;
      ctx.filter = 'saturate(3) hue-rotate(-40deg)'; ctx.drawImage(layer, -o, 0); ctx.filter = 'saturate(3) hue-rotate(140deg)'; ctx.drawImage(layer, o, 0); ctx.restore();
    }
    if (fx.glitch?.enabled && !reduced) {
      const inten = fx.glitch.intensity / 100;
      if (t > glitchUntil && Math.random() < 0.02 * inten * 4) { glitchUntil = t + 60 + Math.random() * 120; glitchSlices = Array.from({ length: 2 + Math.floor(Math.random() * 4) }, () => ({ y: Math.random() * H, h: (4 + Math.random() * 30) * dpr, dx: (Math.random() - 0.5) * 40 * dpr * inten * 2 })); }
      if (t < glitchUntil) for (const s of glitchSlices) ctx.drawImage(canvas, 0, s.y, W, s.h, s.dx, s.y, W, s.h);
    }
    if (fx.pixelate?.enabled) { const f = 1 + fx.pixelate.intensity / 10; ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(canvas, 0, 0, W / f, H / f); ctx.drawImage(canvas, 0, 0, W / f, H / f, 0, 0, W, H); ctx.restore(); }
    if (fx.halftone?.enabled) { ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = fx.halftone.intensity / 100; ctx.fillStyle = ctx.createPattern(makeDotPattern(6 * dpr), 'repeat'); ctx.fillRect(0, 0, W, H); ctx.restore(); }
    if (fx.scanLines?.enabled) { ctx.save(); ctx.globalAlpha = fx.scanLines.intensity / 100 * 0.6; ctx.fillStyle = '#000'; for (let y = 0; y < H; y += 3 * dpr) ctx.fillRect(0, y, W, dpr); ctx.restore(); }
    if (fx.filmGrain?.enabled) { ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = fx.filmGrain.intensity / 100 * 0.5; const ox = reduced ? 0 : Math.floor(Math.random() * 160), oy = reduced ? 0 : Math.floor(Math.random() * 160); ctx.translate(-ox, -oy); ctx.fillStyle = ctx.createPattern(grain, 'repeat'); ctx.fillRect(0, 0, W + 160, H + 160); ctx.restore(); }
    if (fx.filmDust?.enabled && !reduced) { ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.6)'; const n = fx.filmDust.intensity / 10; for (let i = 0; i < n; i++) if (Math.random() < 0.3) ctx.fillRect(Math.random() * W, Math.random() * H, dpr, (2 + Math.random() * 10) * dpr); ctx.restore(); }
    if (fx.vignette?.enabled) { const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${fx.vignette.intensity / 100})`); ctx.save(); ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    if (P.blurType !== 'off' && P.blurAmount > 0) { ctx.save(); ctx.filter = `blur(${P.blurAmount / 10 * dpr}px)`; ctx.drawImage(canvas, 0, 0); ctx.restore(); }
  }

  let last = 0;
  function frame(now) {
    if (!running) return;
    const t = now - t0;
    if (now - last < 40) { raf = requestAnimationFrame(frame); return; }
    last = now;
    if (typeof source.tick === 'function') source.tick(t);
    if (sourceReady()) { const data = sample(); drawBackground(); drawCells(data, t); composite(t); }
    if (reduced || !P.animated) { running = false; return; } // one static frame
    raf = requestAnimationFrame(frame);
  }

  function start() { if (running) return; running = true; resize(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  const onVis = () => (document.hidden ? stop() : start());
  const ro = new ResizeObserver(() => { resize(); if (!running) start(); });
  ro.observe(canvas); document.addEventListener('visibilitychange', onVis);
  if (source instanceof HTMLVideoElement) { source.addEventListener('loadeddata', () => { if (!running) start(); }); source.addEventListener('play', () => { if (!running) start(); }); }
  start();
  return { stop, start, setParams(p) { Object.assign(P, deepMerge(P, p)); resize(); if (!running) start(); }, setSource(s) { source = s; if (!running) start(); }, params: P };
}

function makeGrain(size) {
  const c = document.createElement('canvas'); c.width = size; c.height = size; const x = c.getContext('2d');
  const img = x.createImageData(size, size); for (let i = 0; i < img.data.length; i += 4) { const v = 100 + Math.random() * 110; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  x.putImageData(img, 0, 0); return c;
}
function makeDotPattern(s) { const c = document.createElement('canvas'); c.width = s; c.height = s; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#000'; x.beginPath(); x.arc(s / 2, s / 2, s * 0.28, 0, Math.PI * 2); x.fill(); return c; }

/** Procedural animated source: slow-drifting soft light fields. Call .tick(t) each frame. Swap for a <video> later. */
export function makeFieldSource(w = 640, h = 360) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  const blobs = [
    { r: 0.55, px: 0.25, py: 0.4, sx: 0.00011, sy: 0.00007, a: 0.9 }, { r: 0.45, px: 0.75, py: 0.55, sx: -0.00009, sy: 0.00012, a: 0.8 },
    { r: 0.35, px: 0.55, py: 0.85, sx: 0.00013, sy: -0.00008, a: 0.6 }, { r: 0.3, px: 0.9, py: 0.2, sx: -0.00006, sy: -0.0001, a: 0.5 },
  ];
  c.tick = (t) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i]; const cx = (b.px + Math.sin(t * b.sx * 6 + i) * 0.18) * w; const cy = (b.py + Math.cos(t * b.sy * 6 + i * 2) * 0.16) * h;
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, b.r * w); g.addColorStop(0, `rgba(255,255,255,${b.a})`); g.addColorStop(0.55, `rgba(255,255,255,${b.a * 0.25})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    }
    x.globalCompositeOperation = 'source-over';
  };
  c.tick(0);
  return c;
}
