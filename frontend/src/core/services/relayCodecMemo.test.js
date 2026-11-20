/**
 * Tests for the live relay's per-camera "needs the H.264 sidecar" notes.
 *
 * Runs on Node's built-in test runner (`npm test`). relayCodecMemo.js is pure,
 * so it needs no browser.
 *
 * The case that matters most is the stale note: a browser that could not play
 * H.265 when the note was written and can now. Before these notes carried a
 * reason, such a browser stayed on the slower transcoded stream for good.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECODER_RETRY_MS,
  memoForDecoderFailure,
  memoForDevice,
  memoForMime,
  memoStillApplies,
} from './relayCodecMemo.js';

const NOW = 1_800_000_000_000;
const HEVC_MIME = 'video/mp4; codecs="hev1.1.6.L153.B0"';
const env = (over = {}) => ({
  deviceDecodesHevc: false,
  isTypeSupported: () => false,
  now: NOW,
  ...over,
});

test('no note: the native stream is asked for', () => {
  assert.equal(memoStillApplies(null, env()), false);
  assert.equal(memoStillApplies('', env()), false);
});

test('device note holds while the browser still cannot play H.265', () => {
  assert.equal(memoStillApplies(memoForDevice(), env({ deviceDecodesHevc: false })), true);
});

test('device note is stale once the browser can play H.265', () => {
  assert.equal(memoStillApplies(memoForDevice(), env({ deviceDecodesHevc: true })), false);
});

test("legacy '1' notes are read as device notes", () => {
  assert.equal(memoStillApplies('1', env({ deviceDecodesHevc: false })), true);
  assert.equal(memoStillApplies('1', env({ deviceDecodesHevc: true })), false);
});

test('mime note follows MediaSource for that exact type, not H.265 in general', () => {
  const memo = memoForMime(HEVC_MIME);
  const seen = [];
  const isTypeSupported = (m) => { seen.push(m); return false; };
  assert.equal(memoStillApplies(memo, env({ deviceDecodesHevc: true, isTypeSupported })), true);
  assert.deepEqual(seen, [HEVC_MIME]);
  assert.equal(memoStillApplies(memo, env({ deviceDecodesHevc: true, isTypeSupported: () => true })), false);
});

test('decoder-failure note holds for DECODER_RETRY_MS, then the native stream is retried', () => {
  const memo = memoForDecoderFailure(NOW);
  // Even when the browser claims H.265: that claim is what turned out wrong.
  assert.equal(memoStillApplies(memo, env({ deviceDecodesHevc: true, now: NOW })), true);
  assert.equal(memoStillApplies(memo, env({ deviceDecodesHevc: true, now: NOW + DECODER_RETRY_MS - 1 })), true);
  assert.equal(memoStillApplies(memo, env({ deviceDecodesHevc: true, now: NOW + DECODER_RETRY_MS })), false);
});

test('a decoder-failure note from the future or unreadable is not trusted', () => {
  assert.equal(memoStillApplies(memoForDecoderFailure(NOW + 10 * 60_000), env()), false);
  assert.equal(memoStillApplies('failed:garbage', env()), false);
});
