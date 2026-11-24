// File import (I-7): the SHA-256 is taken while the upload is written, and
// only a plausible time in the file dates the footage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const { hashingStorage } = require('../src/utils/hashingStorage');
const { _internals: { videoFacts } } = require('../src/controllers/imports.controller');

test('the upload is hashed in the same pass that writes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const data = crypto.randomBytes(3 * 1024 * 1024 + 17);
  const store = hashingStorage({ destination: () => path.join(dir, 'x', 'clip.mp4') });
  const info = await new Promise((resolve, reject) => store._handleFile({}, { stream: Readable.from([data.subarray(0, 1e6), data.subarray(1e6)]) },
    (e, i) => (e ? reject(e) : resolve(i))));
  expect(info.size).toBe(data.length);
  expect(info.sha256).toBe(crypto.createHash('sha256').update(data).digest('hex'));
  expect(fs.readFileSync(info.path).equals(data)).toBe(true);
  // An existing file is never overwritten.
  await expect(new Promise((resolve, reject) => store._handleFile({}, { stream: Readable.from([data]) }, (e) => (e ? reject(e) : resolve()))))
    .rejects.toThrow();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recording time from the file only when it is plausible', () => {
  const probe = (created) => ({
    format: { duration: '49.7', tags: created ? { creation_time: created } : {} },
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 768, height: 432, avg_frame_rate: '12/1' }],
  });
  expect(videoFacts(probe('2018-05-09T15:45:38Z')).fileStart.toISOString()).toBe('2018-05-09T15:45:38.000Z');
  expect(videoFacts(probe('1970-01-01T00:00:00Z')).fileStart).toBeNull();      // DVR placeholder
  expect(videoFacts(probe('2099-01-01T00:00:00Z')).fileStart).toBeNull();      // in the future
  expect(videoFacts(probe(null)).durationS).toBeCloseTo(49.7);
  expect(videoFacts({ streams: [{ codec_type: 'audio' }] })).toBeNull();        // no picture: refused
});
