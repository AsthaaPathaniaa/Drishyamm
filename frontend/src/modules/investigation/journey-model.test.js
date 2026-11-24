import test from 'node:test';
import assert from 'node:assert/strict';

import { clickToGrid, groupCandidates, routeLabel, spanMinutes, togetherLabel } from './journey-model.js';

test('a click maps onto the picture inside letterbox bars', () => {
  // 1000x1000 element showing a 16:9 picture: bars above and below.
  const rect = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 500, 500), { x: 500, y: 500 });
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 500, 200), null);         // on the top bar (picture starts at 218.75)
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 250, 500 - 281.25 / 2), { x: 250, y: 250 });
});

test('pillarboxed picture and page offset', () => {
  const rect = { left: 100, top: 50, width: 1600, height: 450 };   // wide element, 16:9 picture 800x450
  assert.deepEqual(clickToGrid(rect, 1920, 1080, 100 + 400 + 400, 50 + 225), { x: 500, y: 500 });
  assert.equal(clickToGrid(rect, 1920, 1080, 150, 100), null);
});

test('candidates group by likelihood and routes read left to right', () => {
  const g = groupCandidates([{ status: 'possible' }, { status: 'likely' }, { status: 'possible' }]);
  assert.equal(g.likely.length, 1);
  assert.equal(g.possible.length, 2);
  assert.equal(routeLabel(['Gate 3', 'Lobby', 'Parking']), 'Gate 3 → Lobby → Parking');
  assert.equal(spanMinutes([{ first_seen: '2026-11-24T10:00:00Z' }, { last_seen: '2026-11-24T10:12:20Z' }]), 12);
});

test('together labels read in seconds, then minutes', () => {
  assert.equal(togetherLabel(12), 'together · 12 s');
  assert.equal(togetherLabel(185), 'together · 3 min');
  assert.equal(togetherLabel(30, 'vehicle'), 'near this vehicle · 30 s');
});
