import { FilesetResolver, ImageSegmenter } from './vendor/mediapipe/vision_bundle.mjs';

let segmenterInstance = null;
let initPromise = null;
let maskCanvas = null;
let maskCtx = null;
let maskImageData = null;
let personLayerCanvas = null;
let personLayerCtx = null;

// Re-running the CPU segmentation model on every single rendered frame is the
// dominant cost of exporting with a webcam background effect on — a talking-head
// mask barely changes within a fraction of a second, so we cap actual inference
// to this rate and reuse the last mask for frames in between (still recomposited
// against that frame's live video pixels, so only the mask, not the image, is stale).
const OM_SEGMENT_INTERVAL_MS = 100;
let lastSegmentAtMs = -Infinity;
let cachedMaskCanvas = null;

// Feeding the model a downscaled copy instead of the full webcam resolution
// cuts CPU-delegate preprocessing cost without affecting mask quality — the
// model's own input resolution is fixed regardless of source size.
const OM_SEGMENT_INPUT_MAX_DIM = 256;
let segmentInputCanvas = null;
let segmentInputCtx = null;

function getSegmentInput(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const scale = Math.min(1, OM_SEGMENT_INPUT_MAX_DIM / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  if (scale >= 1) return videoEl;
  if (!segmentInputCanvas || segmentInputCanvas.width !== w || segmentInputCanvas.height !== h) {
    segmentInputCanvas = document.createElement('canvas');
    segmentInputCanvas.width = w;
    segmentInputCanvas.height = h;
    segmentInputCtx = segmentInputCanvas.getContext('2d');
  }
  segmentInputCtx.drawImage(videoEl, 0, 0, w, h);
  return segmentInputCanvas;
}

async function initSegmenter() {
  if (segmenterInstance) return segmenterInstance;
  if (!initPromise) {
    initPromise = (async () => {
      const wasmFileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/mediapipe/wasm'));
      segmenterInstance = await ImageSegmenter.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL('vendor/mediapipe/selfie_segmenter.tflite'),
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      return segmenterInstance;
    })();
  }
  return initPromise;
}

function isSegmenterReady() {
  return !!segmenterInstance;
}

function maskToCanvas(mask) {
  const w = mask.width;
  const h = mask.height;
  const data = mask.getAsFloat32Array();

  if (!maskCanvas || maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    maskCtx = maskCanvas.getContext('2d');
    maskImageData = maskCtx.createImageData(w, h);
  }

  const px = maskImageData.data;
  for (let i = 0; i < data.length; i++) {
    px[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
  }
  maskCtx.putImageData(maskImageData, 0, 0);
  return maskCanvas;
}

/**
 * Returns a canvas of size targetW x targetH containing only the person
 * (background made transparent via the segmentation mask), or null if the
 * segmenter isn't ready yet / segmentation failed for this frame — callers
 * should fall back to drawing the plain webcam video in that case.
 */
function getPersonLayerCanvas(videoEl, targetW, targetH) {
  if (!segmenterInstance || !videoEl.videoWidth) return null;

  const now = performance.now();
  let maskCanvasSrc = cachedMaskCanvas;

  if (!maskCanvasSrc || now - lastSegmentAtMs >= OM_SEGMENT_INTERVAL_MS) {
    let result;
    try {
      // A monotonically increasing wall-clock timestamp is required by the video
      // running mode, and is safe to use here since it doesn't need to match the
      // video's own currentTime — we only need per-frame segmentation, not
      // temporal smoothing tied to playback position (which can seek backwards).
      result = segmenterInstance.segmentForVideo(getSegmentInput(videoEl), now);
    } catch (err) {
      console.warn('Segmentation failed for this frame', err);
      return null;
    }

    const mask = result.confidenceMasks && result.confidenceMasks[0];
    if (!mask) {
      result.close();
      return null;
    }

    maskCanvasSrc = maskToCanvas(mask);
    result.close();
    cachedMaskCanvas = maskCanvasSrc;
    lastSegmentAtMs = now;
  }

  if (!personLayerCanvas || personLayerCanvas.width !== targetW || personLayerCanvas.height !== targetH) {
    personLayerCanvas = document.createElement('canvas');
    personLayerCanvas.width = targetW;
    personLayerCanvas.height = targetH;
    personLayerCtx = personLayerCanvas.getContext('2d');
  }

  personLayerCtx.globalCompositeOperation = 'source-over';
  personLayerCtx.clearRect(0, 0, targetW, targetH);
  personLayerCtx.drawImage(videoEl, 0, 0, targetW, targetH);
  personLayerCtx.globalCompositeOperation = 'destination-in';
  personLayerCtx.drawImage(maskCanvasSrc, 0, 0, targetW, targetH);
  personLayerCtx.globalCompositeOperation = 'source-over';

  return personLayerCanvas;
}

// Exposed as a global so the non-module editor.js (shared plain-script scope
// with video-processor.js, zoom-analyzer.js, db.js) can call into it.
window.omSegmenter = { initSegmenter, isSegmenterReady, getPersonLayerCanvas };
