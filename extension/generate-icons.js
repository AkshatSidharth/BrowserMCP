// Run once with Node.js to generate PNG icons:  node generate-icons.js
// Requires: npm install canvas  (or use any image editor to create icons manually)

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function makeIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx    = canvas.getContext('2d');
  const r      = size / 2;

  // Background circle
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = '#6c8ef7';
  ctx.fill();

  // Mic icon (simplified)
  ctx.fillStyle = '#fff';
  const mw = size * 0.22, mh = size * 0.32, mx = r - mw / 2, my = size * 0.2;
  const rad = mw / 2;
  // Mic body
  ctx.beginPath();
  ctx.roundRect(mx, my, mw, mh, rad);
  ctx.fill();
  // Mic stand arc
  ctx.beginPath();
  ctx.arc(r, my + mh, size * 0.22, Math.PI, 0, false);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = size * 0.06;
  ctx.stroke();
  // Mic stand line
  ctx.beginPath();
  ctx.moveTo(r, my + mh + size * 0.22);
  ctx.lineTo(r, my + mh + size * 0.34);
  ctx.stroke();
  // Mic stand base
  ctx.beginPath();
  ctx.moveTo(r - size * 0.15, my + mh + size * 0.34);
  ctx.lineTo(r + size * 0.15, my + mh + size * 0.34);
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), makeIcon(size));
  console.log(`Created icon${size}.png`);
}
console.log('Icons generated.');
