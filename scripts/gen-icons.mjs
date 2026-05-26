// One-off PNG generator for app icons. Reads static/icon.svg and emits the
// PWA + iOS icon sizes into static/. Re-run only when the SVG changes.
//
// Usage: node scripts/gen-icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const SVG = await readFile(new URL('../static/icon.svg', import.meta.url));

const sizes = [
  { out: 'icon-192.png', size: 192 },
  { out: 'icon-512.png', size: 512 },
  // Maskable variant: same image, declared with purpose=maskable in the manifest.
  { out: 'icon-maskable-512.png', size: 512 },
  // Apple touch icon — iOS uses this for Add-to-Home-Screen, not the manifest.
  { out: 'apple-touch-icon.png', size: 180 },
];

for (const { out, size } of sizes) {
  await sharp(SVG, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(new URL(`../static/${out}`, import.meta.url).pathname);
  console.log(`wrote static/${out}`);
}
