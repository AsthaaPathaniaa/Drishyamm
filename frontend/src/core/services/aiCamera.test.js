import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FPS, activeFeatureLabels, aiSetupPath, buildDisablePayload, buildEnablePayload, cameraFeatures,
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
  assert.deepEqual(activeFeatureLabels(r), ['Face', 'Unknown', 'Journey', 'Count', 'Zone']);
});

test('features: a drawn gate on a camera with AI off needs setup', () => {
  const f = cameraFeatures(row({ headcount: { enabled: true, zones: [] } }));
  const count = f.find((x) => x.key === 'head_count');
  assert.equal(count.on, false);
  assert.equal(count.needsSetup, true);
});

test('setup path selects the camera', () => {
  assert.equal(aiSetupPath('cam-1'), '/camera-setup?tab=ai-detection&camera=cam-1');
});
