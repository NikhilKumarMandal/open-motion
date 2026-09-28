const OM_GRADIENT_PRESETS = {
  purple: ['#667eea', '#764ba2'],
  sunset: ['#f093fb', '#f5576c'],
  ocean: ['#4facfe', '#00f2fe'],
  forest: ['#0ba360', '#3cba92'],
  midnight: ['#0f2027', '#2c5364'],
};

const OM_CLICK_EFFECT_DURATION_MS = 550;

function omRoundedRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function omHexToRgba(hex, alpha) {
  const m = hex.replace('#', '');
  const r = parseInt(m.substring(0, 2), 16);
  const g = parseInt(m.substring(2, 4), 16);
  const b = parseInt(m.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function omDrawCoverImage(ctx, img, w, h, x = 0, y = 0) {
  const ir = img.width / img.height;
  const cr = w / h;
  let sx, sy, sw, sh;
  if (ir > cr) {
    sh = img.height;
    sw = sh * cr;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / cr;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function omDrawBackground(ctx, canvas, background) {
  if (background?.type === 'image' && background.image) {
    omDrawCoverImage(ctx, background.image, canvas.width, canvas.height);
    return;
  }
  const stops = OM_GRADIENT_PRESETS[background?.value] || OM_GRADIENT_PRESETS.purple;
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, stops[0]);
  grad.addColorStop(1, stops[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function omDrawBrowserFrameBar(ctx, x, y, w, h) {
  const barH = Math.max(20, h * 0.035);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, barH);
  ctx.clip();
  ctx.fillStyle = 'rgba(229,229,229,0.95)';
  ctx.fillRect(x, y, w, barH);
  const dotR = barH * 0.16;
  const dotY = y + barH / 2;
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(x + barH * 0.7 + i * dotR * 3, dotY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  ctx.restore();
}

function omDrawClickEffects(ctx, inset, cursorEvents, t, opts) {
  const color = opts.color || '#667eea';
  const intensity = opts.intensity ?? 0.6;
  for (const e of cursorEvents) {
    if (e.kind !== 'down' && e.kind !== 'click') continue;
    if (e.nx === undefined) continue;
    const age = t - e.t;
    if (age < 0 || age > OM_CLICK_EFFECT_DURATION_MS) continue;
    const p = age / OM_CLICK_EFFECT_DURATION_MS;
    const eased = 1 - Math.pow(1 - p, 3);
    const cx = inset.x + e.nx * inset.w;
    const cy = inset.y + e.ny * inset.h;
    const maxR = Math.min(inset.w, inset.h) * 0.06 * (0.5 + intensity);
    const r = maxR * eased;
    const alpha = (1 - p) * intensity;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = omHexToRgba(color, alpha * 0.5);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = omHexToRgba(color, alpha);
    ctx.stroke();
    ctx.restore();
  }
}

function omDrawSceneInset(ctx, videoEl, transform, inset, browserFrame, overlayFn) {
  const { x, y, w, h } = inset;
  const radius = browserFrame ? 10 : 8;

  ctx.save();
  omRoundedRectPath(ctx, x, y, w, h, radius);
  ctx.clip();

  ctx.save();
  const scale = transform.scale;
  const fx = x + transform.focusX * w;
  const fy = y + transform.focusY * h;
  ctx.translate(fx, fy);
  ctx.scale(scale, scale);
  ctx.translate(-fx, -fy);
  if (videoEl && videoEl.videoWidth) ctx.drawImage(videoEl, x, y, w, h);
  if (overlayFn) overlayFn(ctx);
  ctx.restore();

  if (browserFrame) omDrawBrowserFrameBar(ctx, x, y, w, h);

  ctx.restore();

  ctx.save();
  omRoundedRectPath(ctx, x, y, w, h, radius);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.stroke();
  ctx.restore();
}

function omDrawWebcamPip(ctx, canvas, camVideoEl, opts) {
  if (!camVideoEl.videoWidth) return;
  const sizeFrac = opts.sizeFrac ?? 0.22;
  const margin = canvas.width * 0.02;
  const pipW = canvas.width * sizeFrac;
  const pipH = pipW * (camVideoEl.videoHeight / camVideoEl.videoWidth);

  let x, y;
  switch (opts.corner) {
    case 'bl':
      x = margin;
      y = canvas.height - pipH - margin;
      break;
    case 'tr':
      x = canvas.width - pipW - margin;
      y = margin;
      break;
    case 'tl':
      x = margin;
      y = margin;
      break;
    default:
      x = canvas.width - pipW - margin;
      y = canvas.height - pipH - margin;
  }

  const radius = 16;
  ctx.save();
  omRoundedRectPath(ctx, x, y, pipW, pipH, radius);
  ctx.clip();
  omDrawWebcamFrame(ctx, camVideoEl, x, y, pipW, pipH, opts.background);
  ctx.restore();

  ctx.save();
  omRoundedRectPath(ctx, x, y, pipW, pipH, radius);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
  ctx.restore();
}

// Draws the webcam frame itself, optionally replacing/blurring the real
// background behind the person via the segmenter's alpha mask — falls back
// to the plain video whenever segmentation isn't available yet (still
// loading, or a frame it couldn't process), so this is always safe to call.
function omDrawWebcamFrame(ctx, camVideoEl, x, y, w, h, background) {
  const mode = background?.mode || 'none';
  const segmenter = typeof window !== 'undefined' ? window.omSegmenter : null;

  if (mode === 'none' || !segmenter || !segmenter.isSegmenterReady()) {
    ctx.drawImage(camVideoEl, x, y, w, h);
    return;
  }

  if (mode === 'blur') {
    ctx.save();
    ctx.filter = `blur(${background?.blurPx || 14}px)`;
    ctx.drawImage(camVideoEl, x, y, w, h);
    ctx.restore();
  } else if (mode === 'image' && background?.image) {
    omDrawCoverImage(ctx, background.image, w, h, x, y);
  } else {
    ctx.drawImage(camVideoEl, x, y, w, h);
  }

  const personLayer = segmenter.getPersonLayerCanvas(camVideoEl, Math.round(w), Math.round(h));
  if (personLayer) {
    ctx.drawImage(personLayer, x, y, w, h);
  } else {
    // this frame's segmentation wasn't available — still show the person
    ctx.drawImage(camVideoEl, x, y, w, h);
  }
}

/**
 * Single entry point used by both the editor's live preview and the export loop.
 * state: {
 *   screenVideoEl, camVideoEl,
 *   t,                 // ms since (trimmed) recording start
 *   segments,           // from computeZoomSegments
 *   cursorEvents,
 *   background: { type: 'gradient'|'image', value, image },
 *   insetPadFrac,       // 0 = full-bleed, >0 = padded showing background behind the screen video
 *   browserFrame,       // bool
 *   clickEffects: { enabled, color, intensity },
 *   webcamPip: { enabled, corner, sizeFrac },
 * }
 */
function renderComposite(ctx, canvas, s) {
  const w = canvas.width;
  const h = canvas.height;
  const showBg = s.insetPadFrac > 0;

  if (showBg) {
    omDrawBackground(ctx, canvas, s.background);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }

  const pad = showBg ? Math.min(w, h) * s.insetPadFrac : 0;
  const inset = { x: pad, y: pad, w: w - pad * 2, h: h - pad * 2 };

  const transform = getTransformAtTime(s.segments || [], s.t);

  omDrawSceneInset(ctx, s.screenVideoEl, transform, inset, s.browserFrame, (innerCtx) => {
    if (s.clickEffects?.enabled) {
      omDrawClickEffects(innerCtx, inset, s.cursorEvents || [], s.t, s.clickEffects);
    }
  });

  if (s.webcamPip?.enabled && s.camVideoEl) {
    omDrawWebcamPip(ctx, canvas, s.camVideoEl, s.webcamPip);
  }
}
