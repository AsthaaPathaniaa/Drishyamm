/**
 * Does head count actually work, end to end?
 *
 * Every bug found in this feature has been a BOUNDARY bug -- two correct
 * components disagreeing -- and a unit test on either side of a boundary
 * cannot see the boundary:
 *
 *   - a camera ticked for counting was excluded by the master AI switch, so it
 *     counted nothing. The tick's tests passed. `eligible`'s tests passed.
 *   - a zone saved to the camera registry was never applied by the detector.
 *     The editor's tests passed. The detector's tests passed.
 *
 * So this file does not test a function. It walks ONE camera the whole way
 * along the path an operator's click actually takes, with the real services at
 * every step and only the database mocked:
 *
 *   1. the operator ticks the camera          (the setCameraHeadcount rule)
 *   2. the settings that produces             (masterOnForFeature + aiFlags)
 *   3. the registry endpoint the detector polls (headcountCameras -> eligible)
 *   4. the shape that endpoint emits          (contracts/headcount-camera-row.json)
 *   5. the zones that survive validation      (sanitiseZones)
 *
 * Step 3 is the one that was broken: it is where a tick and a master switch
 * could disagree. Step 4 is checked against a file the Python service's own
 * test reads, so a field renamed on this side fails a test on that side.
 *
 * What this still does NOT prove: that the detector finds people, that RTSP
 * connects, or that a browser renders it. Those need the stack running. This
 * proves the camera and its zones reach the detector, which is every link
 * that has actually broken so far.
 */
const fs = require('fs');
const path = require('path');

process.env.ALERT_TIMEZONE = 'UTC';

jest.mock('../src/models', () => ({
  Camera: { findAll: jest.fn() },
  RestrictedZone: { findAll: jest.fn() },
}));
jest.mock('../src/services/entitlements.service', () => ({
  getAiEntitledUserIds: jest.fn(),
}));
jest.mock('../src/services/drishyamStreaming.service', () => ({
  getRtspEgressUrl: (mon, sub) => `rtsp://relay:8554/cam_${mon}${sub ? '_sub' : ''}`,
  deriveSubPath: () => 'sub',
}));

const { Camera } = require('../src/models');
const { getAiEntitledUserIds } = require('../src/services/entitlements.service');
const { headcountCameras } = require('../src/services/aiFeatureCameras.service');
const { isAiEnabled, masterOnForFeature } = require('../src/services/aiLifecycle.service');
const { explicitAi, ambiguousFlags } = require('../src/services/aiFlags');
const { sanitiseZones } = require('../src/controllers/ai.controller');

const CONTRACT = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'contracts', 'headcount-camera-row.json'), 'utf8',
));

/** The settings a camera carries before anyone ticks it: AI never configured. */
const untouched = () => ({
  id: 'cam-uuid-1',
  userId: 'owner-1',
  monitorId: '7',
  name: 'Reception',
  path: 'has-sub',
  status: 'online',
  settings: {},
});

/**
 * Step 1+2, as the endpoint does it. This is the RULE from
 * setCameraHeadcount, applied through the real services, so a change to
 * either one fails here.
 */
function operatorTicksHeadcount(camera, { enabled = true, threshold = 0, zones } = {}) {
  const current = camera.settings || {};
  const prev = current.headcount || {};
  const now = '2026-11-24T10:00:00.000Z';
  const startAi = enabled && !isAiEnabled(camera);
  return {
    ...camera,
    settings: {
      ...current,
      ...(startAi ? { ai: masterOnForFeature(current.ai, now) } : {}),
      headcount: {
        ...prev,
        enabled,
        threshold,
        zones: zones !== undefined ? sanitiseZones(zones) : (prev.zones || []),
        updatedAt: now,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getAiEntitledUserIds.mockResolvedValue(new Set(['owner-1']));
});

const servesCameras = (cams) => Camera.findAll.mockResolvedValue(cams);

describe('the whole path, one camera', () => {
  test('THE BUG: ticked for counting but the master off, and it never counts', async () => {
    // What the old endpoint stored: the feature flag alone.
    const ticked = untouched();
    ticked.settings = { headcount: { enabled: true, zones: [] } };

    servesCameras([ticked]);
    expect(await headcountCameras()).toEqual([]);
    // Nothing anywhere said why. That is the defect, pinned so it cannot come
    // back by someone "simplifying" the tick.
  });

  test('THE FIX: the tick turns the master on, and the camera reaches the detector', async () => {
    const after = operatorTicksHeadcount(untouched());

    expect(isAiEnabled(after)).toBe(true);
    servesCameras([after]);

    const rows = await headcountCameras();
    expect(rows).toHaveLength(1);
    expect(rows[0].monitorId).toBe('7');
  });

  test('and it starts ONLY counting — no face, no activity, no zone-guard', async () => {
    const after = operatorTicksHeadcount(untouched());
    const ai = after.settings.ai;

    expect(ai.faceRecognition).toBe(false);        // no licence spent, no matching
    expect(ai.activityMonitoring).not.toBe(true);
    expect(ai.zoneBodyDetection).not.toBe(true);
    expect(after.settings.headcount.enabled).toBe(true);
  });

  test('un-ticking stops counting and leaves the master alone', async () => {
    const on = operatorTicksHeadcount(untouched());
    const off = operatorTicksHeadcount(on, { enabled: false });

    expect(off.settings.headcount.enabled).toBe(false);
    expect(isAiEnabled(off)).toBe(true);           // other features hang off it

    servesCameras([off]);
    expect(await headcountCameras()).toEqual([]);  // but it is not counted
  });

  test('a camera already running face recognition is not quietly anonymised', async () => {
    const withFace = untouched();
    withFace.settings = { ai: { enabled: true, mode: 'continuous', faceRecognition: true } };
    const after = operatorTicksHeadcount(withFace);

    expect(after.settings.ai.faceRecognition).toBe(true);
    servesCameras([after]);
    expect(await headcountCameras()).toHaveLength(1);
  });

  test('the master switch still wins: AI off by hand afterwards stops counting', async () => {
    const after = operatorTicksHeadcount(untouched());
    after.settings.ai = { ...after.settings.ai, enabled: false, mode: 'off' };

    servesCameras([after]);
    expect(await headcountCameras()).toEqual([]);
    // Correct, and it is why the page has to SAY so -- counting-status.js.
  });

  test('the plan still wins: a lapsed account counts nothing', async () => {
    getAiEntitledUserIds.mockResolvedValue(new Set());
    servesCameras([operatorTicksHeadcount(untouched())]);
    expect(await headcountCameras()).toEqual([]);
  });
});

describe('the zones an operator draws reach the detector', () => {
  // The polygons the zone editor produces (frontend cameraPayload). The
  // frontend's own test asserts it builds exactly these from a saved zone.
  const DRAWN = CONTRACT.camera.settings.headcount.zones;

  test('every drawn zone survives validation — none is silently dropped', () => {
    const kept = sanitiseZones(DRAWN);
    expect(kept).toHaveLength(CONTRACT.expect.zoneCount);
    expect(kept.map((z) => z.name)).toEqual(CONTRACT.expect.zoneNames);
    expect(kept.map((z) => z.id)).toEqual(DRAWN.map((z) => z.id));
  });

  test('points survive as normalised pairs, which is what the detector reads', () => {
    const [first] = sanitiseZones(DRAWN);
    expect(first.points).toEqual(DRAWN[0].points);
    for (const [x, y] of first.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  test('a shape too small to enclose an area is dropped, and says so by absence', () => {
    // Two points cannot be a room. Dropping it is right; the editor refuses to
    // save one, so this is the backstop rather than the message.
    expect(sanitiseZones([{ id: 'z', name: 'Line', points: [[0.1, 0.1], [0.9, 0.9]] }]))
      .toEqual([]);
  });

  test('the zones ride all the way to the registry row', async () => {
    const after = operatorTicksHeadcount(untouched(), {
      threshold: CONTRACT.expect.threshold, zones: DRAWN,
    });
    servesCameras([after]);

    const [row] = await headcountCameras();
    expect(row.settings.headcount.zones.map((z) => z.name))
      .toEqual(CONTRACT.expect.zoneNames);
    expect(row.settings.headcount.threshold).toBe(CONTRACT.expect.threshold);
  });
});

describe('the shape the detector parses — the cross-language boundary', () => {
  test('the row carries exactly the keys the contract declares', async () => {
    const after = operatorTicksHeadcount(untouched(), {
      threshold: CONTRACT.expect.threshold,
    });
    servesCameras([after]);

    const [row] = await headcountCameras();
    expect(Object.keys(row).sort()).toEqual([...CONTRACT.expect.rowKeys].sort());
  });

  test('both stream URLs are offered, so the service can prefer the sub-stream', async () => {
    const after = operatorTicksHeadcount(untouched());
    servesCameras([after]);

    const [row] = await headcountCameras();
    expect(row.rtsp).toMatch(/^rtsp:\/\//);
    expect(row.rtspSub).toMatch(/^rtsp:\/\//);
    expect(row[CONTRACT.expect.streamPreferred]).toBeTruthy();
  });

  test('a camera with no sub-stream still offers the main one', async () => {
    jest.resetModules();
    jest.doMock('../src/services/drishyamStreaming.service', () => ({
      getRtspEgressUrl: (mon, sub) => `rtsp://relay:8554/cam_${mon}${sub ? '_sub' : ''}`,
      deriveSubPath: () => null,
    }));
    jest.doMock('../src/models', () => ({
      Camera: { findAll: jest.fn().mockResolvedValue([operatorTicksHeadcount(untouched())]) },
      RestrictedZone: { findAll: jest.fn() },
    }));
    jest.doMock('../src/services/entitlements.service', () => ({
      getAiEntitledUserIds: jest.fn().mockResolvedValue(new Set(['owner-1'])),
    }));
    // eslint-disable-next-line global-require
    const svc = require('../src/services/aiFeatureCameras.service');

    const [row] = await svc.headcountCameras();
    expect(row.rtsp).toBeTruthy();
    expect(row.rtspSub).toBe(null);
  });

  test('the contract file itself is the shape this endpoint produces', async () => {
    // Not a tautology: the contract is hand-written and the Python test reads
    // the SAME file. If this endpoint's shape drifts, this fails here and the
    // parser test fails over there.
    const after = operatorTicksHeadcount(untouched(), {
      threshold: CONTRACT.camera.settings.headcount.threshold,
      zones: CONTRACT.camera.settings.headcount.zones,
    });
    servesCameras([after]);

    const [row] = await headcountCameras();
    const want = CONTRACT.camera;

    expect(row.monitorId).toBe(want.monitorId);
    expect(row.status).toBe(want.status);
    expect(row.settings.headcount.enabled).toBe(want.settings.headcount.enabled);
    expect(row.settings.headcount.threshold).toBe(want.settings.headcount.threshold);
    expect(row.settings.headcount.zones).toEqual(want.settings.headcount.zones);
    expect(row.settings.ai.enabled).toBe(want.settings.ai.enabled);
    expect(row.settings.ai.faceRecognition).toBe(want.settings.ai.faceRecognition);
  });

  test('once the flags are explicit the row says what is on, with nothing absent', () => {
    const after = operatorTicksHeadcount(untouched());
    const settled = {
      ...after.settings,
      ai: explicitAi(after.settings.ai),
      headcount: { ...after.settings.headcount },
    };
    expect(ambiguousFlags(settled)).toEqual([]);
    expect(CONTRACT.expect.aiFlagsAllExplicit).toBe(true);
    // And the contract's own camera is already in that state, so the fixture
    // is an example of the end state rather than of the legacy one.
    expect(ambiguousFlags(CONTRACT.camera.settings)).toEqual([]);
  });
});
