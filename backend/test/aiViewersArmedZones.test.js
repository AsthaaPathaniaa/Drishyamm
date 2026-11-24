/**
 * Which cameras' overlay boxes somebody needs.
 *
 * The zone engine's ONLY input is the ephemeral overlay channel
 * (zoneIntrusion.service.js: `on(EVENTS.AI_LIVE_OVERLAY, handleFrame)`), and
 * the face service does not POST to that channel for cameras nobody is
 * watching in a browser:
 *
 *     # backend_forwarder.py
 *     if gating and watched is not None and monitor_id not in watched:
 *         continue
 *
 * `overlay_viewer_gating` defaults to True. So before this change a restricted
 * zone on a face-only camera fired only while an operator had that camera's
 * live view open, and was blind overnight -- the hour it was drawn for.
 *
 * The watched set comes from GET /api/internal/ai/viewers. These tests pin the
 * widening of that answer, and above all the failure mode: an empty list is
 * read by the AI side as "nobody needs anything", which would silence every
 * overlay in the deployment. It must never be the answer to an error.
 */
jest.mock('../src/models', () => ({
  RestrictedZone: { findAll: jest.fn() },
  // zoneIntrusion pulls these in at module scope.
  AIEvent: { create: jest.fn() },
  Camera: { findAll: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/events/bus', () => ({
  on: jest.fn(),
  emit: jest.fn(),
  EVENTS: { AI_LIVE_OVERLAY: 'ai.live.overlay' },
}));

const { RestrictedZone } = require('../src/models');
const logger = require('../src/config/logger');
const zoneIntrusion = require('../src/services/zoneIntrusion.service');

const { armedMonitorIds, overlayNeededMonitorIds, _internals } = zoneIntrusion;
const rows = (...ids) => ids.map((monitorId) => ({ monitorId }));

beforeEach(() => {
  jest.clearAllMocks();
  _internals.resetArmedCache();
});

describe('armedMonitorIds', () => {
  test('asks only for cameras whose zone is ENABLED', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('cam-a'));
    await armedMonitorIds();
    const arg = RestrictedZone.findAll.mock.calls[0][0];
    expect(arg.where).toEqual({ enabled: true });
    // A disabled zone is kept for a re-enable, not deleted, so "every row"
    // would keep boxes flowing for zones an operator has switched off.
    expect(arg.attributes).toEqual(['monitorId']);
  });

  test('de-duplicates a camera carrying several zones', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('cam-a', 'cam-a', 'cam-b'));
    expect((await armedMonitorIds()).sort()).toEqual(['cam-a', 'cam-b']);
  });

  test('drops rows with no monitorId rather than adding an empty id', async () => {
    RestrictedZone.findAll.mockResolvedValue([{ monitorId: 'cam-a' }, { monitorId: null }, {}, null]);
    expect(await armedMonitorIds()).toEqual(['cam-a']);
  });

  test('caches, because every AI shard polls this every couple of seconds', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('cam-a'));
    await armedMonitorIds();
    await armedMonitorIds();
    await armedMonitorIds();
    expect(RestrictedZone.findAll).toHaveBeenCalledTimes(1);
  });

  test('a reset re-reads, so a newly armed zone is picked up', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('cam-a'));
    expect(await armedMonitorIds()).toEqual(['cam-a']);
    RestrictedZone.findAll.mockResolvedValue(rows('cam-a', 'cam-b'));
    _internals.resetArmedCache();
    expect((await armedMonitorIds()).sort()).toEqual(['cam-a', 'cam-b']);
  });
});

describe('overlayNeededMonitorIds', () => {
  test('a camera with an armed zone is included with nobody watching it', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('zone-cam'));
    expect(await overlayNeededMonitorIds([])).toEqual(['zone-cam']);
  });

  test('a browser-watched camera with no zone is still included', async () => {
    RestrictedZone.findAll.mockResolvedValue([]);
    expect(await overlayNeededMonitorIds(['watched-cam'])).toEqual(['watched-cam']);
  });

  test('a camera that is both appears once, not twice', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('both'));
    expect(await overlayNeededMonitorIds(['both'])).toEqual(['both']);
  });

  test('the union is returned, in no particular order', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('zone-cam', 'both'));
    const out = await overlayNeededMonitorIds(['watched-cam', 'both']);
    expect(out.sort()).toEqual(['both', 'watched-cam', 'zone-cam']);
  });

  test('FAILS TO THE BROWSER SET, never to an empty list', async () => {
    // An empty answer is read by the AI forwarder as "nobody needs anything",
    // which would stop the overlay for every camera in the deployment -- the
    // live view as well as the zones. A database blip must not do that.
    RestrictedZone.findAll.mockRejectedValue(new Error('db down'));
    expect(await overlayNeededMonitorIds(['watched-cam'])).toEqual(['watched-cam']);
  });

  test('the failure is logged once, not once per poll', async () => {
    RestrictedZone.findAll.mockRejectedValue(new Error('db down'));
    await overlayNeededMonitorIds([]);
    await overlayNeededMonitorIds([]);
    await overlayNeededMonitorIds([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('and is logged again after a recovery, so a second outage is visible', async () => {
    RestrictedZone.findAll.mockRejectedValue(new Error('db down'));
    await overlayNeededMonitorIds([]);
    RestrictedZone.findAll.mockResolvedValue(rows('cam-a'));
    _internals.resetArmedCache();
    await overlayNeededMonitorIds([]);
    RestrictedZone.findAll.mockRejectedValue(new Error('db down again'));
    _internals.resetArmedCache();
    await overlayNeededMonitorIds([]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test('a missing or malformed watched set does not throw', async () => {
    RestrictedZone.findAll.mockResolvedValue(rows('zone-cam'));
    expect(await overlayNeededMonitorIds()).toEqual(['zone-cam']);
    expect(await overlayNeededMonitorIds(null)).toEqual(['zone-cam']);
    expect(await overlayNeededMonitorIds(['', null, 'ok'])).toEqual(['ok', 'zone-cam']);
  });
});
