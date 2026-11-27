import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

// Draw favicon.svg as an <img> at the sizes browsers use and count pixels that are not the tile, amber or
// ivory ink: antialiasing. The 16 px frame is the hand-tuned pixel grid, so it has none; 32 px and larger
// is the smooth brand mark, so it has plenty.
async function render(page, svg, size, scheme) {
  await page.emulateMedia({colorScheme: scheme});
  await page.setViewportSize({width: size, height: size});
  await page.setContent(`<style>*{margin:0}</style><img id="i" width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
  return page.evaluate(async size => {
    const img = document.getElementById('i'); await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
    const data = context.getImageData(0, 0, size, size).data;
    const tiles = [[21, 22, 29], [36, 37, 45]], inks = {amber: [255, 184, 0], ivory: [242, 242, 239]};
    const near = (pixel, color) => color.every((value, index) => Math.abs(value - pixel[index]) <= 2);
    const margin = size / 8, found = {blurred: 0, amber: 0, ivory: 0};
    for (let y = margin; y < size - margin; y++) for (let x = margin; x < size - margin; x++) {
      const at = (y * size + x) * 4, pixel = [data[at], data[at + 1], data[at + 2]];
      if (near(pixel, inks.amber)) found.amber++;
      else if (near(pixel, inks.ivory)) found.ivory++;
      else if (!tiles.some(tile => near(pixel, tile))) found.blurred++;
    }
    return found;
  }, size);
}

for (const scheme of ['light', 'dark']) test(`favicon.svg: pixel grid at 16 px, smooth mark at 32 and 64 px (${scheme})`, async ({page}) => {
  test.info().annotations.push({type: 'slice', description: 'brand'}, {type: 'check', description: 'favicon-render'});
  const svg = await readFile(new URL('../../public/v1/favicon.svg', import.meta.url), 'utf8');
  const sixteen = await render(page, svg, 16, scheme);
  expect(sixteen.blurred, '16 px glyph area has no antialiased pixels').toBe(0);
  expect(sixteen.amber).toBeGreaterThanOrEqual(40);
  expect(sixteen.ivory).toBeGreaterThanOrEqual(20);
  for (const size of [32, 64]) {
    const smooth = await render(page, svg, size, scheme);
    expect(smooth.blurred, `${size} px frame is the antialiased smooth mark`).toBeGreaterThanOrEqual(size / 2);
    expect(smooth.amber).toBeGreaterThan(0);
  }
});
