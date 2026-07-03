'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'www', 'src', 'icons');
const SIZE = 64;
const STROKE = 5;

function makeCanvas() {
  return new Uint8ClampedArray(SIZE * SIZE * 4);
}

function setPixel(canvas, x, y, alpha = 255) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= SIZE || iy >= SIZE) return;
  const offset = (iy * SIZE + ix) * 4;
  canvas[offset] = 255;
  canvas[offset + 1] = 255;
  canvas[offset + 2] = 255;
  canvas[offset + 3] = Math.max(canvas[offset + 3], alpha);
}

function drawDisc(canvas, cx, cy, radius, alpha = 255) {
  const r = Math.ceil(radius);
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius) setPixel(canvas, x, y, alpha);
    }
  }
}

function drawLine(canvas, x1, y1, x2, y2, width = STROKE) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1) * 2;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    drawDisc(canvas, x1 + dx * t, y1 + dy * t, width / 2);
  }
}

function drawCircle(canvas, cx, cy, radius, width = STROKE) {
  const steps = Math.ceil(radius * Math.PI * 2);
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    drawDisc(canvas, cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, width / 2);
  }
}

function drawArc(canvas, cx, cy, radius, start, end, width = STROKE) {
  const steps = Math.ceil(radius * Math.abs(end - start));
  for (let i = 0; i <= steps; i += 1) {
    const a = start + (end - start) * (i / steps);
    drawDisc(canvas, cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, width / 2);
  }
}

function drawRect(canvas, x, y, w, h) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) setPixel(canvas, xx, yy);
  }
}

function drawRoundedRect(canvas, x, y, w, h, r, width = STROKE) {
  drawLine(canvas, x + r, y, x + w - r, y, width);
  drawLine(canvas, x + w, y + r, x + w, y + h - r, width);
  drawLine(canvas, x + w - r, y + h, x + r, y + h, width);
  drawLine(canvas, x, y + h - r, x, y + r, width);
  drawArc(canvas, x + r, y + r, r, Math.PI, Math.PI * 1.5, width);
  drawArc(canvas, x + w - r, y + r, r, Math.PI * 1.5, Math.PI * 2, width);
  drawArc(canvas, x + w - r, y + h - r, r, 0, Math.PI * 0.5, width);
  drawArc(canvas, x + r, y + h - r, r, Math.PI * 0.5, Math.PI, width);
}

function drawPolygon(canvas, points) {
  let minY = Math.floor(Math.min(...points.map((p) => p[1])));
  let maxY = Math.ceil(Math.max(...points.map((p) => p[1])));
  for (let y = minY; y <= maxY; y += 1) {
    const nodes = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const yi = points[i][1];
      const yj = points[j][1];
      if ((yi < y && yj >= y) || (yj < y && yi >= y)) {
        nodes.push(points[i][0] + ((y - yi) / (yj - yi)) * (points[j][0] - points[i][0]));
      }
    }
    nodes.sort((a, b) => a - b);
    for (let i = 0; i < nodes.length; i += 2) {
      for (let x = Math.floor(nodes[i]); x <= Math.ceil(nodes[i + 1]); x += 1) setPixel(canvas, x, y);
    }
  }
}

function drawPlus(canvas) {
  drawLine(canvas, 32, 20, 32, 44);
  drawLine(canvas, 20, 32, 44, 32);
}

function iconAdd(canvas) {
  drawCircle(canvas, 32, 32, 23);
  drawPlus(canvas);
}

function iconPause(canvas) {
  drawRoundedRect(canvas, 20, 17, 8, 30, 2, 4);
  drawRoundedRect(canvas, 36, 17, 8, 30, 2, 4);
}

function iconPlay(canvas) {
  drawPolygon(canvas, [[23, 17], [23, 47], [47, 32]]);
}

function iconStop(canvas) {
  drawRoundedRect(canvas, 18, 18, 28, 28, 5, 5);
}

function iconSchedule(canvas) {
  drawCircle(canvas, 32, 32, 22);
  drawLine(canvas, 32, 19, 32, 33);
  drawLine(canvas, 32, 33, 43, 39);
}

function iconUndo(canvas) {
  drawArc(canvas, 34, 34, 18, Math.PI * 0.1, Math.PI * 1.45);
  drawLine(canvas, 18, 28, 18, 15);
  drawLine(canvas, 18, 28, 31, 28);
}

function iconMenu(canvas) {
  drawDisc(canvas, 20, 32, 3);
  drawDisc(canvas, 32, 32, 3);
  drawDisc(canvas, 44, 32, 3);
}

function iconChevronUp(canvas) {
  drawLine(canvas, 18, 40, 32, 25);
  drawLine(canvas, 32, 25, 46, 40);
}

function iconChevronDown(canvas) {
  drawLine(canvas, 18, 24, 32, 39);
  drawLine(canvas, 32, 39, 46, 24);
}

function iconMoon(canvas) {
  drawDisc(canvas, 33, 31, 20);
  for (let y = 6; y < 58; y += 1) {
    for (let x = 6; x < 58; x += 1) {
      if (Math.hypot(x - 43, y - 22) < 20) {
        const offset = (y * SIZE + x) * 4;
        canvas[offset + 3] = 0;
      }
    }
  }
}

function iconSun(canvas) {
  drawCircle(canvas, 32, 32, 11);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    drawLine(canvas, 32 + Math.cos(a) * 18, 32 + Math.sin(a) * 18, 32 + Math.cos(a) * 26, 32 + Math.sin(a) * 26);
  }
}

function iconArrowDown(canvas) {
  drawLine(canvas, 32, 14, 32, 42);
  drawLine(canvas, 20, 31, 32, 43);
  drawLine(canvas, 44, 31, 32, 43);
}

function iconClear(canvas) {
  drawRoundedRect(canvas, 15, 19, 36, 26, 6, 5);
  drawLine(canvas, 25, 25, 39, 39);
  drawLine(canvas, 39, 25, 25, 39);
  drawLine(canvas, 15, 32, 8, 32);
}

function iconDrag(canvas) {
  drawLine(canvas, 32, 14, 32, 50);
  drawLine(canvas, 24, 22, 32, 14);
  drawLine(canvas, 40, 22, 32, 14);
  drawLine(canvas, 24, 42, 32, 50);
  drawLine(canvas, 40, 42, 32, 50);
}

function iconEdit(canvas) {
  drawLine(canvas, 20, 44, 44, 20, 6);
  drawLine(canvas, 38, 16, 48, 26, 6);
  drawLine(canvas, 18, 46, 15, 52, 5);
  drawLine(canvas, 15, 52, 21, 49, 5);
}

function iconDuplicate(canvas) {
  drawRoundedRect(canvas, 15, 22, 25, 25, 4, 4);
  drawRoundedRect(canvas, 24, 14, 25, 25, 4, 4);
}

function iconSend(canvas) {
  drawPolygon(canvas, [[12, 13], [52, 32], [12, 51], [21, 34], [35, 32], [21, 30]]);
}

function iconRemove(canvas) {
  drawLine(canvas, 20, 20, 44, 44);
  drawLine(canvas, 44, 20, 20, 44);
}

function iconCheck(canvas) {
  drawLine(canvas, 17, 33, 28, 44);
  drawLine(canvas, 28, 44, 48, 21);
}

function iconRetry(canvas) {
  drawArc(canvas, 32, 32, 20, Math.PI * 0.15, Math.PI * 1.75);
  drawLine(canvas, 49, 22, 50, 10);
  drawLine(canvas, 49, 22, 38, 18);
}

function iconSave(canvas) {
  drawRoundedRect(canvas, 16, 14, 32, 36, 4, 5);
  drawRect(canvas, 24, 14, 17, 11);
  drawLine(canvas, 24, 42, 40, 42, 5);
}

function iconClose(canvas) {
  drawLine(canvas, 20, 20, 44, 44);
  drawLine(canvas, 44, 20, 20, 44);
}

const ICONS = {
  'add-circle': iconAdd,
  pause: iconPause,
  play: iconPlay,
  schedule: iconSchedule,
  stop: iconStop,
  undo: iconUndo,
  menu: iconMenu,
  'chevron-up': iconChevronUp,
  'chevron-down': iconChevronDown,
  moon: iconMoon,
  sun: iconSun,
  'arrow-down': iconArrowDown,
  clear: iconClear,
  drag: iconDrag,
  edit: iconEdit,
  duplicate: iconDuplicate,
  send: iconSend,
  remove: iconRemove,
  check: iconCheck,
  retry: iconRetry,
  save: iconSave,
  close: iconClose,
};

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = crc32(body);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function encodePng(canvas) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(canvas.slice(y * SIZE * 4, (y + 1) * SIZE * 4)).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [name, draw] of Object.entries(ICONS)) {
  const canvas = makeCanvas();
  draw(canvas);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), encodePng(canvas));
}
