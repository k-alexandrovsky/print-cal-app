// Runs the color processing off the main thread so the page stays responsive on big photos.
import { decodeCorrection, render } from "./core.js";

let corr;
self.onmessage = (e) => {
  const { id, correction, pixels, options } = e.data;
  if (correction) {
    corr = decodeCorrection(correction); // a new printer profile was selected
    return;
  }
  if (!pixels) return self.postMessage({ id }); // ping
  const out = render(corr, new Uint8ClampedArray(pixels), options);
  self.postMessage({ id, pixels: out.buffer }, [out.buffer]);
};
