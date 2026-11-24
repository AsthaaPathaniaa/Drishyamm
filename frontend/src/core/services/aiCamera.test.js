import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FPS, activeFeatureLabels, aiSetupPath, buildDisablePayload, buildEnablePayload, cameraFeatures,
  featureSetupPath,
} from './aiCamera.js';

const row = ({ ai, ...over } = {}) => ({
  id: 'cam-1', monitorId: 'm1', name: 'Main Entrance', groupName: 'HQ',
  ai: { enabled: false, ...ai }, headcount: { enabled: false, zones: [] }, ...over,
});

test('enable payload uses one default fps and carries stored settings', () => {
  assert.equal(buildEnablePayload(row()).fps, DEFAULT_FPS);
  const p = buildEnablePayload(row({ ai: { fps: 8, purpose: 'Reception', watchlistAlerts: false } }));
  assert.equal(p.enabled, true);
  assert.equal(p.fps, 8);
  assert.equal(p.purpose, 'Reception');
  assert.equal(p.watchlistAlerts, false);
});

test('enable payload never sends detectionZones unless asked', () => {
  const p = buildEnablePayload(row({ ai: { detectionZones: [{ id: 'z' }] } }));
  assert.equal('detectionZones' in p, false);
  assert.deepEqual(buildEnablePayload(row(), { detectionZones: [] }).detectionZones, []);
});

test('purpose is inferred from the camera name when never set', () => {
  assert.equal(buildEnablePayload(row()).purpose, 'Main gate');
});

test('disable payload keeps choices but turns off', () => {
  const p = buildDisablePayload(row({ ai: { enabled: true, journeyMapping: false } }));
  assert.equal(p.enabled, false);
  assert.equal(p.mode, 'off');
  assert.equal(p.journeyMapping, false);
});

test('features: nothing is on while AI is off', () => {
  assert.deepEqual(activeFeatureLabels(row()), []);
});

test('features: flags and drawn shapes show when AI is on', () => {
  const r = row({
    ai: {
      enabled: true, watchlistAlerts: false,
      detectionZones: [{ shape: 'polygon', enabled: true }, { shape: 'line', enabled: true }],
    },
  });
  // No 'Journey': journey mapping is a feature built on the face model's
  // output, not a model, and Person Tracker owns the per-camera choice.
  assert.deepEqual(activeFeatureLabels(r), ['Face', 'Unknown', 'Count', 'Zone']);
});

test('features: head count is READY only when a gate line is drawn', () => {
  // This test used to be called "a drawn gate ..." while its fixture drew
  // nothing -- `headcount.enabled` with `zones: []` -- and asserted that the
  // bare flag counted as a drawn gate. That is the defect: the row said
  // "Ready" on cameras with no gate line at all. The flag is the row's
  // TOGGLE; a drawn zone is its setup state. They are different questions.
  const flagOnly = cameraFeatures(row({ headcount: { enabled: true, zones: [] } }));
  const bare = flagOnly.find((x) => x.key === 'head_count');
  assert.equal(bare.on, false);
  assert.equal(bare.needsSetup, false, 'a flag with nothing drawn is not a gate');
});

test('features: a drawn gate on a camera with AI off needs setup', () => {
  const f = cameraFeatures(row({ headcount: { enabled: false, zones: [{ enabled: true }] } }));
  const count = f.find((x) => x.key === 'head_count');
  assert.equal(count.on, false);
  assert.equal(count.needsSetup, true);
});

test('features: the alert rows hang off the face model and say they do nothing', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  for (const key of ['unknown_alerts', 'watchlist_alerts']) {
    const r = f.find((x) => x.key === key);
    assert.equal(r.parent, 'face', `${key} belongs under the model that produces it`);
    assert.ok(r.notEnforced, `${key} must state that no service reads it`);
  }
  // Face off hides them: an alert from a model that is not running is not a
  // choice an operator can meaningfully make.
  const anon = cameraFeatures(row({ ai: { enabled: true, faceRecognition: false } }));
  assert.equal(anon.find((x) => x.key === 'unknown_alerts').hidden, true);
  assert.equal(anon.find((x) => x.key === 'watchlist_alerts').hidden, true);
});

test('features: journey mapping is not a model, so it is not a row', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  assert.equal(f.find((x) => x.key === 'journey'), undefined);
});

test('a setup row links to the camera it was opened from', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  const gate = f.find((x) => x.key === 'head_count');
  const zone = f.find((x) => x.key === 'restricted_zone');
  // Both used to link to a bare /occupancy/zone-setup, which opens on whatever
  // camera that page picks for itself.
  assert.equal(featureSetupPath(gate, row()), '/occupancy/zone-setup?gate=m1');
  assert.equal(featureSetupPath(zone, row()), '/occupancy/zone-setup?cam=m1');
});

test('a setup link falls back to the bare page rather than a broken one', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  const gate = f.find((x) => x.key === 'head_count');
  assert.equal(featureSetupPath(gate, {}), '/occupancy/zone-setup');
  assert.equal(featureSetupPath(gate, undefined), '/occupancy/zone-setup');
  assert.equal(featureSetupPath({}, row()), '');
});

test('a monitorId with URL characters is encoded', () => {
  const f = cameraFeatures(row({ ai: { enabled: true } }));
  const gate = f.find((x) => x.key === 'head_count');
  assert.equal(
    featureSetupPath(gate, { monitorId: 'cam 1&x=2' }),
    '/occupancy/zone-setup?gate=cam%201%26x%3D2',
  );
});

test('setup path selects the camera', () => {
  assert.equal(aiSetupPath('cam-1'), '/camera-setup?tab=ai-detection&camera=cam-1');
});
