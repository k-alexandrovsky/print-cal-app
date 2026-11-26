import { decodeCorrection, render, srgbToP3 } from "./core.js";

const MAX_DIM = 3600; // long side of the print file; a 4x6 print at 300 dpi needs 1800
const PREVIEW_DIM = 1200;

const $ = (sel) => document.querySelector(sel);
const P3 = supportsP3();
const SPACE = P3 ? "display-p3" : "srgb";
const state = { corr: null, photos: [], view: "screen", strength: 1 };
window.__printPrep = state; // used by tests

function supportsP3() {
  try {
    const ctx = document.createElement("canvas").getContext("2d", { colorSpace: "display-p3" });
    return ctx.getContextAttributes().colorSpace === "display-p3";
  } catch {
    return false;
  }
}

// --- processing in a worker (falls back to the main thread) ------------------

let worker = null;
let nextId = 0;
const pending = new Map();

async function startWorker(correction) {
  try {
    const w = new Worker("worker.js", { type: "module" });
    w.postMessage({ correction });
    const ok = await new Promise((resolve) => {
      w.onmessage = () => resolve(true);
      w.onerror = () => resolve(false);
      w.postMessage({ id: -1, pixels: new ArrayBuffer(4), options: {} });
      setTimeout(() => resolve(false), 5000);
    });
    if (!ok) return w.terminate();
    w.onmessage = (e) => {
      pending.get(e.data.id)?.(new Uint8ClampedArray(e.data.pixels));
      pending.delete(e.data.id);
    };
    worker = w;
  } catch {
    // module workers unsupported: process on the main thread
  }
}

// Takes ownership of `pixels` (its buffer is transferred to the worker).
function process(pixels, options) {
  if (!worker) return Promise.resolve(render(state.corr, pixels, options));
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    worker.postMessage({ id, pixels: pixels.buffer, options }, [pixels.buffer]);
  });
}

// --- image I/O ---------------------------------------------------------------

function makeCanvas(w, h, space = SPACE) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { colorSpace: space });
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

const release = (canvas) => {
  canvas.width = canvas.height = 0; // frees memory right away on iOS
};

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`Can't open ${file.name}`);
  }
  return { img, url };
}

// Draws the photo (color-managed into the canvas color space), downscaling in halving steps.
function readPixels(img, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  let src = img;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  const temps = [];
  while (sw / 2 > w) {
    sw = Math.round(sw / 2);
    sh = Math.round(sh / 2);
    const step = makeCanvas(sw, sh);
    step.ctx.drawImage(src, 0, 0, sw, sh);
    temps.push(step.canvas);
    src = step.canvas;
  }
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  [...temps, canvas].forEach(release);
  return { data, w, h };
}

function paint(target, pixels, w, h, space) {
  target.width = w;
  target.height = h;
  const ctx = target.getContext("2d", { colorSpace: SPACE });
  const image = new ImageData(pixels, w, h, { colorSpace: space });
  if (space === SPACE) return ctx.putImageData(image, 0, 0);
  const tmp = makeCanvas(w, h, space); // drawImage converts between color spaces
  tmp.ctx.putImageData(image, 0, 0);
  ctx.drawImage(tmp.canvas, 0, 0);
  release(tmp.canvas);
}

async function toJpeg(pixels, w, h) {
  const { canvas, ctx } = makeCanvas(w, h, "srgb");
  ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
  release(canvas);
  return blob;
}

// --- photos --------------------------------------------------------------------

let queue = Promise.resolve();
const schedule = (job) => (queue = queue.then(job).catch(showError));

function addPhoto(file) {
  const stem = file.name.replace(/\.[^.]+$/, "") || "photo";
  const card = $("#card").content.firstElementChild.cloneNode(true);
  const photo = {
    file, card, gen: 0, preview: null, views: {}, blob: null,
    outName: `${stem}_selphy.jpg`,
    canvas: card.querySelector("canvas"),
    status: card.querySelector(".status"),
  };
  card.querySelector(".name").textContent = file.name;
  card.querySelector(".remove").onclick = () => {
    photo.gen = -1;
    state.photos = state.photos.filter((p) => p !== photo);
    card.remove();
    update();
  };
  $("#photos").append(card);
  state.photos.push(photo);
  schedule(() => renderPhoto(photo));
}

async function renderPhoto(photo) {
  const gen = photo.gen;
  if (gen < 0) return;
  setStatus(photo, "Preparing…");
  const { img, url } = await loadImage(photo.file);
  let full;
  try {
    if (!photo.preview) {
      const p = readPixels(img, PREVIEW_DIM);
      photo.preview = { w: p.w, h: p.h, screen: p.data, p3: P3 ? p.data : srgbToP3(p.data.slice()) };
      await showView(photo);
    }
    full = readPixels(img, MAX_DIM);
  } finally {
    URL.revokeObjectURL(url);
  }
  const p3 = P3 ? full.data : srgbToP3(full.data);
  const out = await process(p3, { view: "print", strength: state.strength });
  const blob = await toJpeg(out, full.w, full.h);
  if (gen !== photo.gen) return; // settings changed meanwhile; a newer job is queued
  photo.blob = blob;
  setStatus(photo, `Ready · ${full.w}×${full.h}`);
  update();
}

async function showView(photo) {
  const p = photo.preview;
  if (!p) return;
  const { view, strength } = state;
  if (view === "screen") return paint(photo.canvas, p.screen, p.w, p.h, SPACE);
  const key = view === "as-is" ? view : `${view}@${strength}`;
  photo.views[key] ??= await process(p.p3.slice(), { view, strength });
  if (state.view === view && state.strength === strength) paint(photo.canvas, photo.views[key], p.w, p.h, "srgb");
}

function setStatus(photo, text) {
  photo.status.textContent = text;
}

// --- UI ------------------------------------------------------------------------

function update() {
  const n = state.photos.length;
  const ready = state.photos.filter((p) => p.blob).length;
  $("#controls").hidden = n === 0;
  $("#pick-label").textContent = n ? "Add photos" : "Choose photos";
  const share = $("#share");
  share.disabled = n === 0 || ready < n;
  share.textContent = n === 0 ? "Save / Share" : ready < n ? `Preparing ${ready + 1} of ${n}…` : `Save / Share ${n} photo${n > 1 ? "s" : ""}`;
}

function showError(err) {
  const el = $("#error");
  el.textContent = err?.message || String(err);
  el.hidden = false;
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => (el.hidden = true), 6000);
}

function showCalibration(meta) {
  const parts = [];
  if (meta.created) parts.push(`Calibrated ${meta.created.slice(0, 10)}`);
  if (meta.typical_dE_before != null) {
    parts.push(`typical colors ${meta.typical_dE_before.toFixed(1)} → ${meta.typical_dE_after.toFixed(1)} ΔE (predicted)`);
  }
  $("#calibration").textContent = parts.join(" · ");
  $("#demo").hidden = !meta.demo;
}

async function share() {
  const files = state.photos.map((p) => new File([p.blob], p.outName, { type: "image/jpeg" }));
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
    } catch (e) {
      if (e.name !== "AbortError") showError(e);
    }
    return;
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
}

function bindControls() {
  $("#pick").addEventListener("change", (e) => {
    [...e.target.files].forEach(addPhoto);
    e.target.value = "";
    update();
  });
  for (const btn of document.querySelectorAll("[data-view]")) {
    btn.onclick = () => {
      state.view = btn.dataset.view;
      document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      state.photos.forEach((p) => schedule(() => showView(p)));
    };
  }
  let timer;
  $("#strength").addEventListener("input", (e) => {
    $("#strength-out").textContent = `${e.target.value}%`;
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.strength = Number(e.target.value) / 100;
      for (const p of state.photos) {
        p.gen++;
        p.blob = null;
        p.views = {};
        schedule(() => showView(p));
        schedule(() => renderPhoto(p));
      }
      update();
    }, 300);
  });
  $("#share").onclick = share;
}

async function init() {
  bindControls();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  let correction;
  try {
    const res = await fetch("correction.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.statusText);
    correction = await res.json();
  } catch {
    $("#pick").disabled = true;
    return showError("No calibration found: correction.json is missing next to this page.");
  }
  state.corr = decodeCorrection(correction);
  showCalibration(state.corr.meta);
  await startWorker(correction);
  document.body.dataset.ready = "1";
}

init();
