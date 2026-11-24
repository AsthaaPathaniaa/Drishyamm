// Evidence packs (investigation toolkit I-5): a sealed pack verifies; one
// changed byte anywhere makes it fail; the export needs a reason; the
// feature is opt-in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { ZipWriter, listEntries } = require('../src/services/evidence/zip');
const { buildManifest, sign, verifyPack, fingerprint, MANIFEST, SIGNATURE, PUBLIC_KEY } = require('../src/services/evidence/manifest');
const { isFeatureOn } = require('../src/utils/featureCatalog');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

async function makePack(name, { extra } = {}) {
  const video = path.join(tmp, `${name}.mp4`);
  fs.writeFileSync(video, crypto.randomBytes(300_000));
  const zipPath = path.join(tmp, `${name}.zip`);
  const zip = new ZipWriter(zipPath);
  const files = [
    { ...(await zip.addFile('video/original.mp4', video)), kind: 'video-original' },
    { ...zip.addBuffer('report/case_report.pdf', Buffer.from('%PDF-1.4 test')), kind: 'report' },
    { ...zip.addBuffer(PUBLIC_KEY, Buffer.from(PUB)), kind: 'public-key' },
  ];
  const manifest = buildManifest({
    exportId: 'e1', createdAt: '2026-11-24T10:00:00Z', createdBy: 'Asha', reason: 'theft at gate 3, FIR 123',
    camera: { monitorId: 'm1', name: 'Gate 3' }, range: { start: 'a', end: 'b' }, files, keyFingerprint: fingerprint(PUB), software: 'test',
  });
  zip.addBuffer(MANIFEST, manifest);
  zip.addBuffer(SIGNATURE, Buffer.from(sign(manifest, PRIV)));
  if (extra) zip.addBuffer(extra, Buffer.from('sneaked in'));
  zip.close();
  return zipPath;
}

function flipByteIn(zipPath, entryName, at = 10) {
  const e = listEntries(zipPath).find((x) => x.name === entryName);
  const fd = fs.openSync(zipPath, 'r+');
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, e.offset + at);
  b[0] ^= 0x01;
  fs.writeSync(fd, b, 0, 1, e.offset + at);
  fs.closeSync(fd);
}

test('an untouched pack verifies', async () => {
  const r = await verifyPack(await makePack('good'));
  expect(r.error).toBeNull();
  expect(r.signatureOk).toBe(true);
  expect(r.ok).toBe(true);
  expect(r.files.map((f) => f.path).sort()).toEqual(['public_key.pem', 'report/case_report.pdf', 'video/original.mp4']);
});

test('one changed byte in the video fails, and says which file', async () => {
  const p = await makePack('video-tamper');
  flipByteIn(p, 'video/original.mp4', 123_456);
  const r = await verifyPack(p);
  expect(r.ok).toBe(false);
  expect(r.signatureOk).toBe(true);
  expect(r.files.filter((f) => !f.ok).map((f) => f.path)).toEqual(['video/original.mp4']);
});

test('one changed byte in the manifest breaks the signature', async () => {
  const p = await makePack('manifest-tamper');
  flipByteIn(p, MANIFEST, 40);
  const r = await verifyPack(p);
  expect(r.ok).toBe(false);
  expect(r.signatureOk).toBe(false);
});

test('a re-signed pack with another key is not this signer\'s', async () => {
  const p = await makePack('other-key');
  const r = await verifyPack(p, { trustedFingerprints: ['0'.repeat(64)] });
  expect(r.signatureOk).toBe(false);
});

test('a file added to the pack is reported', async () => {
  const r = await verifyPack(await makePack('extra', { extra: 'video/edited.mp4' }));
  expect(r.ok).toBe(false);
  expect(r.unlisted).toEqual(['video/edited.mp4']);
});

test('not a zip is a clean failure, not a crash', async () => {
  const p = path.join(tmp, 'junk.zip');
  fs.writeFileSync(p, 'hello');
  const r = await verifyPack(p);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not a ZIP/);
});

test('evidence_export is opt-in', () => {
  expect(isFeatureOn(null, 'evidence_export')).toBe(false);
  expect(isFeatureOn(['evidence_export'], 'evidence_export')).toBe(true);
});

describe('POST /api/evidence', () => {
  jest.resetModules();
  test('refuses an export without a real reason, before touching the recorder', async () => {
    jest.doMock('../src/models', () => ({ EvidenceExport: { create: jest.fn() } }));
    const loadCamera = jest.fn();
    jest.doMock('../src/controllers/playback.controller', () => ({
      nvrPull: { loadCamera, parseRange: () => ({ startMs: 0, endMs: 1000 }), MAX_EXPORT_MS: 1, exportsByUser: new Map(), assertPlayback: () => {} },
    }));
    const ctrl = require('../src/controllers/evidence.controller');
    const err = await new Promise((resolve) => {
      ctrl.create({ user: { id: 'u1' }, body: { monitorId: 'm1', start: 'a', end: 'b', reason: 'because' } }, {}, resolve);
    });
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/why/);
    expect(loadCamera).not.toHaveBeenCalled();
  });
});
