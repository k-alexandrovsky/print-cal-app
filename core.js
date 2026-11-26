// Pure color math shared by the page, the worker and the tests. No DOM access here.

const P3_TO_SRGB = [
  [1.2247453, -0.2249044, 0.0],
  [-0.042058, 1.0420809, 0.0],
  [-0.0196423, -0.0786549, 1.0985372],
];
const SRGB_TO_P3 = [
  [0.8225929, 0.1775339, 0.0],
  [0.0331995, 0.9667835, 0.0],
  [0.0170854, 0.0723957, 0.9103014],
];

// sRGB and Display P3 share this transfer function
const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function unpack(b64) {
  const bin = atob(b64);
  const out = new Float32Array(bin.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)) / 65535;
  }
  return out;
}

// LUTs are Float32Arrays indexed [r][g][b][channel], values 0..1.
// correct: Display P3 photo -> what to send to the printer (sRGB-tagged)
// simulate: what is sent to the printer -> how the print looks (sRGB), for previews
export function decodeCorrection(json) {
  return { n: json.size, correct: unpack(json.p3), simulate: unpack(json.sim), meta: json.meta || {} };
}

// Display P3 pixels -> what to send to the printer.
//   view "print":     the file to print (strength 0 = as-is, 1 = full correction)
//   view "as-is":     simulated print of the uncorrected photo
//   view "corrected": simulated print of the corrected photo
export function render(corr, src, { view = "print", strength = 1 } = {}) {
  const out = new Uint8ClampedArray(src);
  if (view === "as-is") {
    p3ToSrgb(out);
  } else {
    applyLut(corr.correct, corr.n, out, out);
    if (strength < 1) {
      const asIs = p3ToSrgb(new Uint8ClampedArray(src));
      for (let i = 0; i < out.length; i++) out[i] = asIs[i] + (out[i] - asIs[i]) * strength;
    }
  }
  if (view !== "print") applyLut(corr.simulate, corr.n, out, out);
  return out;
}

// Trilinear lookup of 8-bit RGBA pixels: src -> dst (may be the same array).
export function applyLut(lut, n, src, dst) {
  const i0 = new Int32Array(256);
  const fr = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const x = (v * (n - 1)) / 255;
    const i = Math.min(Math.floor(x), n - 2);
    i0[v] = i;
    fr[v] = x - i;
  }
  const sR = n * n * 3;
  const sG = n * 3;
  for (let p = 0; p < src.length; p += 4) {
    const r = src[p], g = src[p + 1], b = src[p + 2];
    const tr = fr[r], tg = fr[g], tb = fr[b];
    const base = i0[r] * sR + i0[g] * sG + i0[b] * 3;
    for (let c = 0; c < 3; c++) {
      const o = base + c;
      const c00 = lut[o] + (lut[o + 3] - lut[o]) * tb;
      const c01 = lut[o + sG] + (lut[o + sG + 3] - lut[o + sG]) * tb;
      const c10 = lut[o + sR] + (lut[o + sR + 3] - lut[o + sR]) * tb;
      const c11 = lut[o + sR + sG] + (lut[o + sR + sG + 3] - lut[o + sR + sG]) * tb;
      const c0 = c00 + (c01 - c00) * tg;
      const c1 = c10 + (c11 - c10) * tg;
      dst[p + c] = (c0 + (c1 - c0) * tr) * 255; // Uint8ClampedArray rounds and clamps
    }
    dst[p + 3] = 255;
  }
  return dst;
}

// Re-encode pixels in place between Display P3 and sRGB (out-of-range colors clipped).
// p3ToSrgb is what printing the photo without correction does; srgbToP3 is the fallback
// for browsers without Display P3 canvases.
export const p3ToSrgb = (data) => convertPrimaries(data, P3_TO_SRGB);
export const srgbToP3 = (data) => convertPrimaries(data, SRGB_TO_P3);

let tables;
function convertPrimaries(data, [m0, m1, m2]) {
  if (!tables) {
    const lin = new Float32Array(256);
    for (let v = 0; v < 256; v++) lin[v] = decode(v / 255);
    const enc = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) enc[i] = Math.round(encode(i / 65535) * 255);
    tables = { lin, enc };
  }
  const { lin, enc } = tables;
  for (let p = 0; p < data.length; p += 4) {
    const r = lin[data[p]], g = lin[data[p + 1]], b = lin[data[p + 2]];
    data[p] = enc[Math.round(clamp01(m0[0] * r + m0[1] * g + m0[2] * b) * 65535)];
    data[p + 1] = enc[Math.round(clamp01(m1[0] * r + m1[1] * g + m1[2] * b) * 65535)];
    data[p + 2] = enc[Math.round(clamp01(m2[0] * r + m2[1] * g + m2[2] * b) * 65535)];
  }
  return data;
}
