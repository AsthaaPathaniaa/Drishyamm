// Build one evidence pack (investigation toolkit I-5).
//
//   1. Pull the range from the recorder ONCE, stream-copied ("original"),
//      hashing the bytes as they are written (forensic rule 12). Same NVR path
//      as Recordings › Export: the NVR is claimed for this user, one pull per
//      user at a time, 30 minutes at most.
//   2. Re-encode that file locally to H.264 (no second NVR pull), hashed.
//   3. Smart Search photos of the tracks the pack is about, if any.
//   4. case_report.pdf (+ draft Section 63 certificate), README.txt.
//   5. manifest.json over all of it, signed with the organisation's Ed25519
//      key; everything into one ZIP; ZIP hash recorded.
// The EvidenceExport row goes building → ready | failed. Never throws.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const config = require('../../config/env');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');
const { ZipWriter, sha256File } = require('./zip');
const { buildManifest, sign, MANIFEST, SIGNATURE, PUBLIC_KEY } = require('./manifest');
const { getSigningKey } = require('./keys');
const { renderReport, readme } = require('./report');

const EVIDENCE_DIR = process.env.EVIDENCE_DIR
  || path.join(config.streamService?.recordingsDir || '/recordings', '_evidence');
const SOFTWARE = `Drishyam backend ${require('../../../package.json').version}`;

const redact = (s) => String(s || '').replace(/\/\/[^@\s/]*@/g, '//***@');
// A pack must hold (nearly) the whole range it claims. Below this share of
// the requested seconds it fails instead of sealing a short clip.
const MIN_COVERAGE = 0.9;

/** Seconds of video in a file (last − first video packet time), 0 if none. */
function videoSeconds(file) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
    '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const ts = (r.stdout || '').split('\n').map(Number).filter(Number.isFinite);
  if (ts.length < 2) return 0;
  return Math.max(...ts) - Math.min(...ts);
}

/** ffmpeg → file, hashing every byte written. Resolves { size, sha256 }. */
function ffmpegToFile(args, outPath, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(outPath);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let tail = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-600); });
    proc.stdout.on('data', (c) => {
      hash.update(c);
      size += c.length;
      if (!out.write(c)) { proc.stdout.pause(); out.once('drain', () => proc.stdout.resume()); }
    });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      out.end(() => {
        if (!size) return reject(new Error(`no video came back${tail ? `: ${redact(tail).trim().slice(-160)}` : ''}`));
        if (code !== 0) logger.warn('evidence: ffmpeg ended with an error after writing footage', { code, tail: redact(tail).slice(-200) });
        return resolve({ size, sha256: hash.digest('hex') });
      });
    });
  });
}

// ffmpeg writes `outPath` itself (Recordings' export args end in a finished,
// +faststart MP4, which can't go to a pipe); hashed once it's closed.
function ffmpegWritesFile(args, outPath, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-600); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(outPath).size; } catch { /* not written */ }
      if (!size) return reject(new Error(`no video came back${tail ? `: ${redact(tail).trim().slice(-160)}` : ''}`));
      if (code !== 0) logger.warn('evidence: ffmpeg ended with an error after writing footage', { code, tail: redact(tail).slice(-200) });
      const hash = crypto.createHash('sha256');
      fs.createReadStream(outPath)
        .on('data', (c) => hash.update(c))
        .on('error', reject)
        .on('end', () => resolve({ size, sha256: hash.digest('hex') }));
    });
  });
}

async function pullOriginal(cam, startMs, endMs, outPath) {
  const { nvrPull, exportArgs } = require('../../controllers/playback.controller');
  const edgeRelay = require('../edgeRelay.service');
  const nvr = nvrPull.claimNvr(cam, 'export');
  let src = null;
  try {
    src = await nvrPull.playbackSource(cam, startMs, endMs);
    const durationSec = Math.ceil((endMs - startMs) / 1000);
    // Slow recorder uplinks replay below real time (seen at 0.1x): give them
    // room, but not forever.
    const result = await ffmpegWritesFile(exportArgs(src.url, durationSec, 'original', outPath), outPath,
      { timeoutMs: (durationSec * 3 + 180) * 1000 });
    const got = videoSeconds(outPath);
    if (got < durationSec * MIN_COVERAGE) {
      throw new Error(`the recorder sent only ${Math.round(got)} s of the ${durationSec} s asked for, so no pack was sealed. `
        + 'Check that the recorder has footage for this time; on a slow recorder link, try a shorter range.');
    }
    return { ...result, h264: !!src.h264, seconds: got };
  } finally {
    nvr.release();
    if (src?.edgeJob) edgeRelay.closeReplay(src.edgeJob);
  }
}

async function transcodeH264(inPath, outPath, durationSec) {
  // GPU (NVENC + CUDA decode) when the host has it, else libx264.
  const enc = await require('../h264Encode').h264Encode();
  return ffmpegToFile([
    '-hide_banner', '-loglevel', 'error', ...enc.input, '-i', inPath,
    // passthrough: one output frame per recorded frame, no duplicates or drops.
    '-map', '0:v:0', '-fps_mode', 'passthrough', ...enc.video,
    '-map', '0:a:0?', '-c:a', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
  ], outPath, { timeoutMs: (durationSec * 4 + 120) * 1000 });
}

async function fetchTracks(user, monitorId, trackIds) {
  if (!trackIds?.length) return [];
  const axios = require('axios');
  const { aiAuthHeader } = require('../../utils/aiTenant');
  const ai = axios.create({ baseURL: process.env.AI_SERVICE_URL || 'http://smart-cam-ai:8001', timeout: 15_000 });
  const out = [];
  for (const id of trackIds.slice(0, 20)) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a handful, in order
      const { data } = await ai.get(`/investigate/tracks/${encodeURIComponent(id)}`, { headers: aiAuthHeader(user) });
      if (data.camera_code !== monitorId) continue;            // only this camera's tracks belong in this pack
      // eslint-disable-next-line no-await-in-loop
      const img = await ai.get(`/investigate/tracks/${encodeURIComponent(id)}/crop`, { headers: aiAuthHeader(user), responseType: 'arraybuffer' });
      out.push({ ...data, photo: Buffer.from(img.data) });
    } catch (e) {
      logger.warn('evidence: track left out', { id, error: e.message });
    }
  }
  return out;
}

/**
 * @param {object} row   EvidenceExport (status 'building')
 * @param {object} cam   playback.controller loadCamera() result
 * @param {object} user  req.user (for the AI tenant token)
 * @param {object} meta  { scores: { trackId: score }, timeZone }
 */
async function buildPack(row, cam, user, meta = {}) {
  const { nvrPull } = require('../../controllers/playback.controller');
  const work = path.join(EVIDENCE_DIR, '.work', row.id);
  const dir = path.join(EVIDENCE_DIR, row.tenantId);
  const zipPath = path.join(dir, `${row.id}.zip`);
  const startMs = new Date(row.startAt).getTime();
  const endMs = new Date(row.endAt).getTime();
  const lock = { evidence: row.id };
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });

    const files = [];
    const original = path.join(work, 'original.mp4');
    nvrPull.exportsByUser.set(user.id, lock);
    let pulled;
    try {
      pulled = await pullOriginal(cam, startMs, endMs, original);
    } finally {
      if (nvrPull.exportsByUser.get(user.id) === lock) nvrPull.exportsByUser.delete(user.id);
    }
    files.push({ path: 'video/original.mp4', src: original, kind: 'video-original', ...pulled });
    if (!pulled.h264) {
      const h264 = path.join(work, 'h264.mp4');
      const t = await transcodeH264(original, h264, Math.ceil((endMs - startMs) / 1000));
      files.push({ path: 'video/h264.mp4', src: h264, kind: 'video-h264', ...t });
    }

    const tracks = await fetchTracks(user, row.monitorId, row.trackIds);
    for (const t of tracks) {
      const p = path.join(work, `${t.track_id}.jpg`);
      fs.writeFileSync(p, t.photo);
      files.push({ path: `photos/${t.track_id}.jpg`, src: p, kind: 'photo', size: t.photo.length,
        sha256: crypto.createHash('sha256').update(t.photo).digest('hex') });
      t.score = meta.scores?.[t.track_id] ?? null;
      t.camera_name = cam.camera.name;
    }

    const key = await getSigningKey(row.tenantId);
    const recorder = cam.edge ? 'site relay' : (cam.group?.name || cam.deviceType);
    const info = {
      exportId: row.id,
      createdAt: row.createdAt,
      createdBy: row.createdByName || row.createdBy,
      reason: row.reason,
      camera: { monitorId: row.monitorId, name: cam.camera.name, recorder },
      range: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
      tracks,
      keyFingerprint: key.fingerprint,
      software: SOFTWARE,
      timeZone: meta.timeZone,
    };
    const pdf = await renderReport({ ...info, files: files.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 })) });
    const extras = [
      { path: 'report/case_report.pdf', buf: pdf, kind: 'report' },
      { path: 'README.txt', buf: Buffer.from(readme(info), 'utf8'), kind: 'readme' },
      { path: PUBLIC_KEY, buf: Buffer.from(key.publicKeyPem, 'utf8'), kind: 'public-key' },
    ];

    const zip = new ZipWriter(`${zipPath}.part`);
    const listed = [];
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop -- sequential write into one ZIP
      const w = await zip.addFile(f.path, f.src);
      if (w.sha256 !== f.sha256) throw new Error(`${f.path} changed on disk while the pack was built`);
      listed.push({ ...w, kind: f.kind });
    }
    for (const e of extras) listed.push({ ...zip.addBuffer(e.path, e.buf), kind: e.kind });
    const manifest = buildManifest({
      exportId: row.id, createdAt: new Date(row.createdAt).toISOString(), createdBy: info.createdBy, reason: row.reason,
      camera: info.camera, range: info.range, files: listed, keyFingerprint: key.fingerprint, software: SOFTWARE,
    });
    const signature = sign(manifest, key.privateKeyPem);
    zip.addBuffer(MANIFEST, manifest);
    zip.addBuffer(SIGNATURE, Buffer.from(`${signature}\n`, 'utf8'));
    const { size } = zip.close();
    fs.renameSync(`${zipPath}.part`, zipPath);
    const zipSha = await sha256File(zipPath);

    await row.update({
      status: 'ready', error: null, files: listed, signature, keyFingerprint: key.fingerprint,
      manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex'),
      zipPath, zipSize: size, zipSha256: zipSha,
    });
    logger.info('evidence: pack ready', { id: row.id, monitorId: row.monitorId, bytes: size });
    audit('evidence.export_ready', { targetType: 'evidence_export', targetId: row.id, meta: { zipSha256: zipSha, bytes: size } });
  } catch (err) {
    logger.warn('evidence: pack failed', { id: row.id, error: redact(err.message) });
    try { fs.rmSync(`${zipPath}.part`, { force: true }); } catch { /* nothing to remove */ }
    await row.update({ status: 'failed', error: redact(err.message).slice(0, 500) }).catch(() => {});
    audit('evidence.export_ready', { targetType: 'evidence_export', targetId: row.id, outcome: 'failure', meta: { error: redact(err.message) } });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { buildPack, pullOriginal, EVIDENCE_DIR, _internals: { ffmpegToFile } };
