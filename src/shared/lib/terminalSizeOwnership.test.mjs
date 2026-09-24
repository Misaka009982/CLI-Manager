import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVisibleDesktopViewportSize,
  registerDesktopViewport,
  hasVisibleDesktopViewport,
  restoreDesktopViewportSize,
} from './terminalSizeOwnership.ts';

test('visible layout owns size before output subscribe; hidden parser does not', () => {
  let visible = true;
  let restores = 0;
  const dispose = registerDesktopViewport('a', {
    visible: () => visible,
    restore: () => restores++,
    dimensions: () => ({ cols: 120, rows: 32 }),
  });
  assert.equal(hasVisibleDesktopViewport('a'), true);
  assert.deepEqual(getVisibleDesktopViewportSize('a'), { cols: 120, rows: 32 });
  restoreDesktopViewportSize('a');
  assert.equal(restores, 1);
  visible = false;
  assert.equal(hasVisibleDesktopViewport('a'), false);
  assert.equal(getVisibleDesktopViewportSize('a'), null);
  restoreDesktopViewportSize('a');
  assert.equal(restores, 1);
  visible = true;
  restoreDesktopViewportSize('a');
  assert.equal(restores, 2);
  dispose();
  assert.equal(hasVisibleDesktopViewport('a'), false);
});

test('overlapping layout cleanup cannot remove newer viewport or another session', () => {
  const viewport = { visible: () => true, restore() {}, dimensions: () => ({ cols: 80, rows: 24 }) };
  const old = registerDesktopViewport('a', viewport);
  const next = registerDesktopViewport('a', viewport);
  const other = registerDesktopViewport('b', viewport);
  old();
  assert.equal(hasVisibleDesktopViewport('a'), true);
  next();
  assert.equal(hasVisibleDesktopViewport('a'), false);
  assert.equal(hasVisibleDesktopViewport('b'), true);
  other();
});
