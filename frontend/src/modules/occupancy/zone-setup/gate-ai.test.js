/**
 * Tests for the AI half of saving a gate.
 *
 * Runs on Node's built-in test runner (`npm test`), with the two backend calls
 * mocked: the camera list (GET /ai/cameras) and the per-camera lifecycle PATCH
 * that Camera Setup's AI Detection tab uses. What is checked: a gate on a
 * camera with AI off turns AI on, it is turned on for the RIGHT id, an
 * already-running camera is left alone, a plan without AI is never asked, a
 * camera's drawn detection areas survive, and every way the backend can say no
 * leaves the operator told rather than thrown at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TURNED_ON, PLAN_PATH, enableAiPayload, ensureAiForGate, findAiCamera, gatePurpose,
} from './gate-ai.js';

/** One row as GET /ai/cameras serialises it (serializeAiCamera, backend). */
const row = ({ ai, ...over } = {}) => ({
  id: 'cam-db-uuid',
  monitorId: 'MON7',
  name: 'Front entrance',
  groupName: 'Main block',
  ...over,
  ai: {
    enabled: false,
    mode: 'off',
    fps: 8,
    purpose: '',
    priority: 'normal',
    unknownAlerts: true,
    watchlistAlerts: true,
    journeyMapping: true,
    detectionZones: [{ id: 'z1', points: [] }],
    ...ai,
  },
});

/** Mocks that record what they were called with. */
function mocks({ rows = [row()], listThrows = null, enableResult = { reconcile: { ok: true } }, enableThrows = null } = {}) {
  const calls = { list: 0, enable: [] };
  return {
    calls,
    listCameras: async () => {
      calls.list += 1;
      if (listThrows) throw listThrows;
      return { success: true, data: rows };
    },
    enableCamera: async (cameraId, payload) => {
      calls.enable.push({ cameraId, payload });
      if (enableThrows) throw enableThrows;
      return enableResult;
    },
  };
}

test('a gate on a camera with AI off turns AI on, and says so', async () => {
  const m = mocks();
  const out = await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(out.status, 'turned-on');
  assert.equal(out.note, AI_TURNED_ON);
  assert.match(out.note, /AI turned on for this camera so the gate can count/);
  assert.equal(m.calls.enable.length, 1);
});

test('it is turned on for the backend camera id, not the footfall one', async () => {
  // The gate itself is saved under the footfall service's own camera_id; the
  // lifecycle route takes smart-cam-backend's camera id. Confusing the two
  // 404s, and the gate goes on counting nothing.
  const m = mocks({ rows: [row({ id: 'cam-db-uuid', monitorId: 'MON7' })] });
  await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(m.calls.enable[0].cameraId, 'cam-db-uuid');
});

test('the payload starts the pipeline and keeps the settings the camera had', async () => {
  const m = mocks({ rows: [row({ ai: { enabled: false, fps: 6, priority: 'high', purpose: 'Loading bay', unknownAlerts: false } })] });
  await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  const { payload } = m.calls.enable[0];
  assert.equal(payload.enabled, true);
  assert.equal(payload.mode, 'continuous');
  assert.equal(payload.fps, 6);
  assert.equal(payload.priority, 'high');
  assert.equal(payload.purpose, 'Loading bay');
  assert.equal(payload.unknownAlerts, false);
  assert.equal(payload.watchlistAlerts, true);
});

test('detection areas are never sent, so turning AI on cannot wipe one', async () => {
  // The backend keeps the stored zones when the field is absent. Sending the
  // field at all risks overwriting an area drawn in AI Feed.
  const m = mocks();
  await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal('detectionZones' in m.calls.enable[0].payload, false);
  // The exact key set, deliberately: an allow-list is the only form that keeps
  // catching a NEW field being added to the payload, which is how
  // `detectionZones` would creep back in. `faceRecognition` is a legitimate
  // addition -- the face feature split out of the `enabled` master switch --
  // so it is listed rather than the assertion being loosened.
  assert.deepEqual(
    Object.keys(enableAiPayload(row())).sort(),
    ['detectionInputSize', 'enabled', 'faceRecognition', 'fps', 'journeyMapping', 'mode', 'priority', 'purpose', 'unknownAlerts', 'watchlistAlerts'],
  );
});

test('a camera already running AI is left alone, and nothing is said', async () => {
  const m = mocks({ rows: [row({ ai: { enabled: true, mode: 'continuous' } })] });
  const out = await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(out.status, 'already-on');
  assert.equal(out.note, '');
  assert.equal(m.calls.enable.length, 0);
});

test('a plan without AI is never asked to start anything', async () => {
  const m = mocks();
  const out = await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: false, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(out.status, 'blocked');
  assert.equal(m.calls.list, 0);
  assert.equal(m.calls.enable.length, 0);
});

test('a camera the backend does not list is reported, not started blindly', async () => {
  const m = mocks({ rows: [row({ monitorId: 'OTHER' })] });
  const out = await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(out.status, 'unknown');
  assert.match(out.note, /The gate is saved/);
  assert.match(out.note, /AI Detection/);
  assert.equal(m.calls.enable.length, 0);
});

test('a refused lifecycle call never throws: the gate did save', async () => {
  const m = mocks({ enableThrows: Object.assign(new Error('Request failed'), { response: { data: { message: 'Camera licence limit reached' } } }) });
  const out = await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(out.status, 'failed');
  assert.match(out.note, /The gate is saved/);
  assert.match(out.note, /Camera licence limit reached/);
});

test('AI on but the AI service not started is not reported as counting', async () => {
  const m = mocks({ enableResult: { reconcile: { ok: false, error: 'AI service unreachable' } } });
  const out = await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(out.status, 'failed');
  assert.match(out.note, /AI service unreachable/);
  assert.match(out.note, /Nothing is counted/);
});

test('an unreadable camera list is reported, not swallowed', async () => {
  const m = mocks({ listThrows: new Error('Network Error') });
  const out = await ensureAiForGate({
    monitorId: 'MON7', planAllowsAi: true, listCameras: m.listCameras, enableCamera: m.enableCamera,
  });
  assert.equal(out.status, 'unverified');
  assert.match(out.note, /could not be checked/);
  assert.equal(m.calls.enable.length, 0);
});


test('finding the camera row, and naming a gate', () => {
  const rows = [row({ monitorId: 'A' }), row({ monitorId: 'B', id: 'id-b' })];
  assert.equal(findAiCamera(rows, 'B').id, 'id-b');
  assert.equal(findAiCamera(rows, 'C'), null);
  assert.equal(findAiCamera(rows, ''), null);
  assert.equal(findAiCamera(null, 'A'), null);
  assert.equal(gatePurpose(row({ ai: { purpose: 'Cash counter' } })), 'Cash counter');
  assert.equal(gatePurpose(row({ name: 'Reception desk' })), 'Reception');
  // A camera being made a gate is a gate, not the "Restricted area" default.
  assert.equal(gatePurpose(row({ name: 'Cam 3', groupName: 'Block B' })), 'Main gate');
});

test('the plan link points at a route that exists', () => {
  // /pricing is parked in App.jsx; the plan is shown on Settings > Organization.
  assert.equal(PLAN_PATH, '/settings?tab=organization');
});
