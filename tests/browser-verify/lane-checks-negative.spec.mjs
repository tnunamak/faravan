// Negative controls for the lane's own detectors: real defects must be reported, and text nobody can see must not be.
import { test, expect } from '@playwright/test';
import { overflowProblems, clippedText } from './lib.mjs';

const render = async (page, width, body) => {
  await page.setViewportSize({width, height: 600});
  await page.setContent('<!doctype html><style>body{margin:0;font:14px/20px sans-serif}.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>' + body);
};

test('clippedText reports a visible label cut by a fixed box', async ({page}) => {
  await render(page, 640, '<div style="width:60px;overflow:hidden;white-space:nowrap">A visible label that does not fit</div>');
  expect(await clippedText(page)).toEqual(['A visible label that does not fit is clipped']);
});
test('clippedText reports a line box that cuts text vertically', async ({page}) => {
  await render(page, 640, '<div style="height:10px;overflow:hidden;width:100px">One line<br>Two lines<br>Three lines</div>');
  expect((await clippedText(page)).length).toBe(1);
});
test('clippedText ignores screen-reader-only text', async ({page}) => {
  await render(page, 640, '<div style="width:300px">Docker Sandboxes<span class="sr"> · Done</span></div>');
  expect(await clippedText(page)).toEqual([]);
});

test('overflowProblems reports a visible control past the viewport edge', async ({page}) => {
  await render(page, 320, '<a href="#x" style="position:absolute;left:200px;white-space:nowrap">A link that runs past the edge</a>');
  expect((await overflowProblems(page)).some(p => p.includes('is cut off'))).toBe(true);
});
test('overflowProblems ignores a control inside a closed details, and sees it once opened', async ({page}) => {
  await render(page, 320, '<details><summary>More</summary><p style="white-space:nowrap">A long sentence with <a href="#x">a link that sits at the far end of it</a></p></details>');
  expect(await overflowProblems(page)).toEqual([]);
  await page.evaluate(() => { document.querySelector('details').open = true; });
  expect((await overflowProblems(page)).some(p => p.includes('is cut off'))).toBe(true);
});
