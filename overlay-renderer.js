/**
 * Open-Motions Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// Overlay Renderer - cursor, keystroke and blur overlays shared by the editor
// preview and the export pipeline, so both draw exactly the same thing.
//
// Coordinates:
// - Cursor/keystroke events store page-viewport positions normalised to 0-1.
// - Video pixels: the viewport sits below the browser UI and above any cropped
//   taskbar (same assumption the click highlights use).
// - A "map" describes how a source rect of the video lands on the canvas:
//   { sx, sy, sw, sh, dx, dy, dw, dh }.

const OverlayRenderer = (() => {
  const CURSOR_SIZES = { '1': 1, '1.5': 1.5, '2': 2, '3': 3 };
  const CURSOR_SMOOTHING = { low: 40, medium: 110, high: 200 };  // Averaging half-window (ms)
  const CURSOR_IDLE_MS = 2000;      // Hide after this long without movement
  const CURSOR_FADE_MS = 250;
  const CLICK_PRESS_MS = 180;       // Cursor "press" animation length

  const KEY_SIZES = { small: 0.032, medium: 0.042, large: 0.056 };  // Font size as a share of frame height
  const KEY_VISIBLE_MS = 1500;
  const KEY_FADE_IN_MS = 100;
  const KEY_FADE_OUT_MS = 300;
  const KEY_MAX_SHOWN = 3;

  const POINTER_TYPES = new Set(['move', 'click', 'doubleclick', 'mousedown']);
  const CLICK_TYPES = new Set(['click', 'doubleclick']);

  // Same estimate the editor and exporter use for the tab strip + address bar
  function browserUIHeight(videoHeight) {
    return Math.min(105, Math.floor(videoHeight * 0.08) + 5);
  }

  function normalizedPoint(event) {
    if (event.normalizedX !== undefined && !isNaN(event.normalizedX)) {
      return { nx: event.normalizedX, ny: event.normalizedY };
    }
    if (event.viewportWidth) {
      return { nx: event.x / event.viewportWidth, ny: event.y / event.viewportHeight };
    }
    return null;
  }

  // Page-viewport point (0-1) -> video pixels
  function viewportToVideo(nx, ny, frame) {
    const top = browserUIHeight(frame.videoHeight);
    const height = frame.videoHeight - top - (frame.bottomCrop || 0);
    return { x: nx * frame.videoWidth, y: top + ny * height };
  }

  function mapPoint(map, x, y) {
    return {
      x: map.dx + ((x - map.sx) / map.sw) * map.dw,
      y: map.dy + ((y - map.sy) / map.sh) * map.dh
    };
  }

  function lowerBound(times, t) {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // ========== CURSOR ==========

  function buildCursorTrack(cursorData) {
    const samples = [];
    const clicks = [];
    for (const d of cursorData || []) {
      if (!POINTER_TYPES.has(d.type)) continue;
      const p = normalizedPoint(d);
      if (!p) continue;
      samples.push({ t: d.timestamp, nx: p.nx, ny: p.ny });
      if (CLICK_TYPES.has(d.type)) clicks.push(d.timestamp);
    }
    samples.sort((a, b) => a.t - b.t);
    clicks.sort((a, b) => a - b);
    return {
      samples,
      times: samples.map((s) => s.t),
      clicks
    };
  }

  // Piecewise-linear position at time t (clamped to the first/last sample)
  function rawPosition(track, t) {
    const { samples, times } = track;
    const i = lowerBound(times, t);
    if (i <= 0) return samples[0];
    if (i >= samples.length) return samples[samples.length - 1];
    const a = samples[i - 1];
    const b = samples[i];
    const span = b.t - a.t;
    const k = span > 0 ? (t - a.t) / span : 0;
    return { nx: a.nx + (b.nx - a.nx) * k, ny: a.ny + (b.ny - a.ny) * k };
  }

  // Triangle-weighted average of the path around t: removes the 50ms sampling
  // jitter and gives the glide. Deterministic, so seeking and export match.
  function smoothPosition(track, t, halfWindow) {
    if (halfWindow <= 0) return rawPosition(track, t);
    const steps = 6;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let i = -steps; i <= steps; i++) {
      const w = steps + 1 - Math.abs(i);
      const p = rawPosition(track, t + (i / steps) * halfWindow);
      sx += p.nx * w;
      sy += p.ny * w;
      sw += w;
    }
    return { nx: sx / sw, ny: sy / sw };
  }

  function cursorOpacity(track, t, hideWhenIdle) {
    const { samples, times } = track;
    if (samples.length === 0 || t < samples[0].t - CURSOR_FADE_MS) return 0;
    const fadeIn = Math.min(1, (t - (samples[0].t - CURSOR_FADE_MS)) / CURSOR_FADE_MS);
    if (!hideWhenIdle) return fadeIn;

    // Time since the last movement and until the next one
    const i = lowerBound(times, t + 1e-6);
    const prev = i > 0 ? times[i - 1] : -Infinity;
    const next = i < times.length ? times[i] : Infinity;
    const idleFor = t - prev;
    if (idleFor <= CURSOR_IDLE_MS) return fadeIn;
    const fadeOut = 1 - Math.min(1, (idleFor - CURSOR_IDLE_MS) / CURSOR_FADE_MS);
    const comeBack = 1 - Math.min(1, (next - t) / CURSOR_FADE_MS);
    return Math.max(fadeOut, comeBack) * fadeIn;
  }

  function pressScale(track, t) {
    const i = lowerBound(track.clicks, t - CLICK_PRESS_MS);
    const click = track.clicks[i];
    if (click === undefined || click > t + 60) return 1;
    // Dip to 0.82 at the click, then spring back
    const k = (t - (click - 60)) / (CLICK_PRESS_MS + 60);
    return 1 - 0.18 * Math.sin(Math.min(1, Math.max(0, k)) * Math.PI);
  }

  // Arrow drawn in a 0-24 unit box, tip at (0, 0)
  function traceArrow(ctx) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17.5);
    ctx.lineTo(4.2, 13.6);
    ctx.lineTo(7.1, 20.3);
    ctx.lineTo(10.1, 19);
    ctx.lineTo(7.3, 12.4);
    ctx.lineTo(12.9, 12.4);
    ctx.closePath();
  }

  /**
   * opts: { size: '1'|'1.5'|'2'|'3', smoothing: 'low'|'medium'|'high', hideWhenIdle }
   * frame: { videoWidth, videoHeight, bottomCrop }
   */
  function drawCursor(ctx, track, tMs, map, frame, opts) {
    if (!track || track.samples.length === 0) return;
    const alpha = cursorOpacity(track, tMs, opts.hideWhenIdle);
    if (alpha <= 0.01) return;

    const p = smoothPosition(track, tMs, CURSOR_SMOOTHING[opts.smoothing] ?? CURSOR_SMOOTHING.medium);
    const v = viewportToVideo(p.nx, p.ny, frame);
    const pt = mapPoint(map, v.x, v.y);

    // Base height ~22px on a 1080p source, scaled with the video and the zoom
    const scale = CURSOR_SIZES[opts.size] || 1.5;
    const unit = (frame.videoHeight / 1080) * (22 / 20) * scale * (map.dh / map.sh) * pressScale(track, tMs);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(pt.x, pt.y);
    ctx.scale(unit, unit);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3 * unit;
    ctx.shadowOffsetY = 1 * unit;
    traceArrow(ctx);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#111111';
    ctx.fill();
    ctx.restore();
  }

  // ========== KEYSTROKES ==========

  function buildKeyTrack(cursorData) {
    const items = (cursorData || [])
      .filter((d) => d.type === 'keystroke' && d.key)
      .map((d) => ({ t: d.timestamp, label: String(d.key) }))
      .sort((a, b) => a.t - b.t);
    return { items, times: items.map((k) => k.t) };
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * area: the region to place labels in (the whole output frame), not zoomed.
   * opts: { size: 'small'|'medium'|'large', position: 'left'|'center'|'right' }
   */
  function drawKeystrokes(ctx, track, tMs, area, opts) {
    if (!track || track.items.length === 0) return;
    const end = lowerBound(track.times, tMs + 1e-6);
    const visible = [];
    for (let i = end - 1; i >= 0 && visible.length < KEY_MAX_SHOWN; i--) {
      const age = tMs - track.items[i].t;
      if (age > KEY_VISIBLE_MS) break;
      visible.unshift({ key: track.items[i], age });
    }
    if (visible.length === 0) return;

    const fontPx = Math.max(10, area.h * (KEY_SIZES[opts.size] || KEY_SIZES.medium));
    const padX = fontPx * 0.6;
    const pillH = fontPx * 1.75;
    const gap = fontPx * 0.4;
    const radius = fontPx * 0.45;

    ctx.save();
    ctx.font = `500 ${fontPx}px 'Geist', 'Segoe UI', system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const widths = visible.map((v) => ctx.measureText(v.key.label).width + padX * 2);
    const total = widths.reduce((s, w) => s + w, 0) + gap * (widths.length - 1);
    const margin = area.h * 0.06;
    let x;
    if (opts.position === 'left') x = area.x + margin;
    else if (opts.position === 'right') x = area.x + area.w - margin - total;
    else x = area.x + (area.w - total) / 2;
    const y = area.y + area.h - margin - pillH;

    visible.forEach((v, i) => {
      const w = widths[i];
      const fadeIn = Math.min(1, v.age / KEY_FADE_IN_MS);
      const fadeOut = Math.min(1, (KEY_VISIBLE_MS - v.age) / KEY_FADE_OUT_MS);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
      const lift = (1 - fadeIn) * pillH * 0.25;

      ctx.globalAlpha = alpha;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
      ctx.shadowBlur = fontPx * 0.6;
      ctx.shadowOffsetY = fontPx * 0.15;
      roundRectPath(ctx, x, y + lift, w, pillH, radius);
      ctx.fillStyle = 'rgba(17, 17, 17, 0.86)';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = Math.max(1, fontPx * 0.05);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(v.key.label, x + w / 2, y + lift + pillH / 2 + fontPx * 0.04);
      x += w + gap;
    });
    ctx.restore();
  }

  // ========== BLUR ==========

  function regionActive(region, tMs) {
    const start = region.start ?? 0;
    const end = region.end ?? Infinity;
    return tMs >= start && tMs <= end;
  }

  /**
   * regions: [{ x, y, w, h, start?, end? }] with x/y/w/h as 0-1 of the full video frame.
   * source: the <video> element being drawn.
   */
  function drawBlurRegions(ctx, source, regions, tMs, map, frame) {
    if (!regions || regions.length === 0) return;
    const radius = Math.max(6, map.dw * 0.012);
    const srcPerDest = map.sw / map.dw;

    for (const r of regions) {
      if (!regionActive(r, tMs)) continue;
      const vx = r.x * frame.videoWidth;
      const vy = r.y * frame.videoHeight;
      const vw = r.w * frame.videoWidth;
      const vh = r.h * frame.videoHeight;
      const a = mapPoint(map, vx, vy);
      const b = mapPoint(map, vx + vw, vy + vh);
      if (b.x <= a.x || b.y <= a.y) continue;

      // Sample a margin around the box so the blur doesn't fade to transparent at the edges
      const m = radius * 2 * srcPerDest;
      const sx = Math.max(0, vx - m);
      const sy = Math.max(0, vy - m);
      const sw = Math.min(frame.videoWidth, vx + vw + m) - sx;
      const sh = Math.min(frame.videoHeight, vy + vh + m) - sy;
      const d0 = mapPoint(map, sx, sy);
      const d1 = mapPoint(map, sx + sw, sy + sh);

      ctx.save();
      ctx.beginPath();
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.clip();
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(source, sx, sy, sw, sh, d0.x, d0.y, d1.x - d0.x, d1.y - d0.y);
      ctx.filter = 'none';
      // Slight veil so very large text can't be read through a light blur
      ctx.fillStyle = 'rgba(128, 128, 128, 0.12)';
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    }
  }

  return {
    browserUIHeight,
    viewportToVideo,
    buildCursorTrack,
    drawCursor,
    buildKeyTrack,
    drawKeystrokes,
    drawBlurRegions
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OverlayRenderer;
}
