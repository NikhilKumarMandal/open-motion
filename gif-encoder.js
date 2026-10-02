/**
 * Open-Motions Screen Recorder
 * Copyright (c) 2026 Anu S Pillai
 * GitHub: https://github.com/anugotta
 *
 * Licensed under the MIT License.
 */

// GIF Encoder - small animated GIF writer with no dependencies.
// Frames are quantised to a fixed 6x7x6 colour cube with ordered (Bayer) dithering,
// which is fast enough to run during export and stable from frame to frame.
// Pixels that didn't change since the previous frame become transparent, so static
// screen content costs almost nothing.

class GifEncoder {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.parts = [];
    this.prevIndices = null;
    this.indices = new Uint8Array(width * height);
    this.frameCount = 0;
    this.pendingDelayCs = 0;
    this.writeHeader();
  }

  static get TRANSPARENT() {
    return 255;
  }

  static buildPalette() {
    // 6 red x 7 green x 6 blue = 252 colours, then 3 extra greys; index 255 is transparent
    const palette = new Uint8Array(256 * 3);
    let i = 0;
    for (let r = 0; r < 6; r++) {
      for (let g = 0; g < 7; g++) {
        for (let b = 0; b < 6; b++) {
          palette[i++] = Math.round((r * 255) / 5);
          palette[i++] = Math.round((g * 255) / 6);
          palette[i++] = Math.round((b * 255) / 5);
        }
      }
    }
    for (const grey of [64, 128, 192]) {
      palette[i++] = grey;
      palette[i++] = grey;
      palette[i++] = grey;
    }
    return palette;
  }

  bytes(arr) {
    this.parts.push(arr instanceof Uint8Array ? arr : new Uint8Array(arr));
  }

  word(n) {
    return [n & 0xff, (n >> 8) & 0xff];
  }

  writeHeader() {
    // "GIF89a", logical screen, global colour table (256 entries)
    this.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    this.bytes([...this.word(this.width), ...this.word(this.height), 0xf7, 0, 0]);
    this.bytes(GifEncoder.buildPalette());
    // NETSCAPE2.0: loop forever
    this.bytes([0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0, 0, 0]);
  }

  quantize(rgba) {
    const { width, height, indices } = this;
    // 4x4 Bayer matrix, centred around 0
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const stepRB = 255 / 5;
    const stepG = 255 / 6;
    let p = 0;
    for (let y = 0; y < height; y++) {
      const row = (y & 3) << 2;
      for (let x = 0; x < width; x++, p++) {
        const o = p << 2;
        const d = (bayer[row | (x & 3)] + 0.5) / 16 - 0.5;
        const r = Math.min(5, Math.max(0, Math.round(rgba[o] / stepRB + d)));
        const g = Math.min(6, Math.max(0, Math.round(rgba[o + 1] / stepG + d)));
        const b = Math.min(5, Math.max(0, Math.round(rgba[o + 2] / stepRB + d)));
        indices[p] = r * 42 + g * 6 + b;
      }
    }
    return indices;
  }

  /**
   * Add a frame. `rgba` is ImageData.data at the encoder size; `delayMs` is how long
   * this frame stays on screen.
   */
  addFrame(rgba, delayMs) {
    const current = this.quantize(rgba);
    let out = current;

    // Unchanged pixels -> transparent (previous frame shows through)
    if (this.prevIndices) {
      out = new Uint8Array(current.length);
      const prev = this.prevIndices;
      for (let i = 0; i < current.length; i++) {
        out[i] = current[i] === prev[i] ? GifEncoder.TRANSPARENT : current[i];
      }
      this.prevIndices.set(current);
    } else {
      this.prevIndices = new Uint8Array(current);
    }

    // GIF delays are in 1/100 s; carry the rounding error to the next frame
    const exact = delayMs / 10 + this.pendingDelayCs;
    const delayCs = Math.max(2, Math.round(exact));
    this.pendingDelayCs = exact - delayCs;

    // Graphic control: disposal 1 (keep), transparent colour flag on
    const flags = this.frameCount === 0 ? 0x04 : 0x05;
    this.bytes([0x21, 0xf9, 0x04, flags, ...this.word(delayCs), GifEncoder.TRANSPARENT, 0]);
    // Image descriptor: full frame, no local colour table
    this.bytes([0x2c, 0, 0, 0, 0, ...this.word(this.width), ...this.word(this.height), 0]);
    this.writeLzw(out);
    this.frameCount++;
  }

  writeLzw(indices) {
    const minCodeSize = 8;
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const out = [];
    let block = [];
    let bitBuffer = 0;
    let bitCount = 0;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let dict = new Map();

    const emit = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        block.push(bitBuffer & 0xff);
        bitBuffer >>>= 8;
        bitCount -= 8;
        if (block.length === 255) {
          out.push(255, ...block);
          block = [];
        }
      }
    };

    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const existing = dict.get(key);
      if (existing !== undefined) {
        prefix = existing;
        continue;
      }
      emit(prefix);
      if (nextCode < 4096) {
        dict.set(key, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clearCode);
        dict = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (bitCount > 0) block.push(bitBuffer & 0xff);
    if (block.length > 0) out.push(block.length, ...block);
    out.push(0);

    this.bytes([minCodeSize]);
    this.bytes(out);
  }

  finish() {
    this.bytes([0x3b]);
    return new Blob(this.parts, { type: 'image/gif' });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GifEncoder;
}
