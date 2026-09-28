Vendored from `@mediapipe/tasks-vision` (npm) and `storage.googleapis.com/mediapipe-models`, both published by Google under the Apache License 2.0 (http://www.apache.org/licenses/LICENSE-2.0).

- `vision_bundle.mjs` — `@mediapipe/tasks-vision` JS API (ImageSegmenter, FilesetResolver)
- `wasm/vision_wasm_internal.js` + `wasm/vision_wasm_internal.wasm` — the SIMD WASM runtime the API loads; only this one variant is kept (the `nosimd` and `module` variants that ship in the npm package are unused and were dropped, since this only needs to run on evergreen Chrome)
- `selfie_segmenter.tflite` — the general Selfie Segmentation model

All three are loaded strictly from this local `vendor/` copy (see `manifest.json`'s `connect-src 'self'` CSP) — nothing here is fetched from a CDN at runtime.
