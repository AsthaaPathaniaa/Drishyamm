// Evidence pack manifest: what is in the pack, each file's SHA-256, and an
// Ed25519 signature over the manifest's exact bytes. Verifying a pack:
//   1. the signature over manifest.json checks out with public_key.pem;
//   2. every file the manifest lists is in the ZIP with that SHA-256 and size;
//   3. nothing else is in the ZIP besides manifest.json / manifest.sig.
// Change one byte anywhere and one of those fails.
const crypto = require('node:crypto');
const { listEntries, entrySha256, readEntry } = require('./zip');

const MANIFEST = 'manifest.json';
const SIGNATURE = 'manifest.sig';
const PUBLIC_KEY = 'public_key.pem';
const UNLISTED = new Set([MANIFEST, SIGNATURE]);

function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function sign(bytes, privateKeyPem) {
  return crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

function verifySignature(bytes, signatureB64, publicKeyPem) {
  try {
    return crypto.verify(null, bytes, crypto.createPublicKey(publicKeyPem), Buffer.from(String(signatureB64).trim(), 'base64'));
  } catch (_) {
    return false;
  }
}

/** The manifest's bytes (pretty JSON, so a person can read it too). */
function buildManifest({ exportId, createdAt, createdBy, reason, camera, range, files, keyFingerprint, software }) {
  const doc = {
    format: 'drishyam-evidence/1',
    export_id: exportId,
    created_at: createdAt,
    created_by: createdBy,
    reason,
    camera,
    range,
    hash: 'SHA-256',
    signature: { algorithm: 'Ed25519', file: SIGNATURE, public_key: PUBLIC_KEY, key_fingerprint: keyFingerprint },
    software,
    files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, kind: f.kind })),
  };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/**
 * Check a pack on disk. Never throws for a bad pack; returns
 * { ok, signatureOk, manifest, keyFingerprint, files: [{ path, ok, expected, actual, size }],
 *   missing: [], unlisted: [], error }
 */
async function verifyPack(zipPath, { trustedFingerprints = null } = {}) {
  const out = { ok: false, signatureOk: false, manifest: null, keyFingerprint: null, files: [], missing: [], unlisted: [], error: null };
  let entries;
  try {
    entries = listEntries(zipPath);
  } catch (e) {
    out.error = e.message;
    return out;
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const need = (n) => {
    const e = byName.get(n);
    if (!e) throw new Error(`${n} is missing from the pack`);
    return e;
  };
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = readEntry(zipPath, need(MANIFEST));
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    out.manifest = manifest;
    const pub = readEntry(zipPath, need(PUBLIC_KEY)).toString('utf8');
    const sig = readEntry(zipPath, need(SIGNATURE)).toString('utf8');
    out.keyFingerprint = fingerprint(pub);
    out.signatureOk = verifySignature(manifestBytes, sig, pub)
      && out.keyFingerprint === manifest?.signature?.key_fingerprint
      && (!trustedFingerprints || trustedFingerprints.includes(out.keyFingerprint));
  } catch (e) {
    out.error = e.message;
    return out;
  }

  const listed = new Set();
  for (const f of manifest.files || []) {
    listed.add(f.path);
    const e = byName.get(f.path);
    if (!e) { out.missing.push(f.path); continue; }
    // eslint-disable-next-line no-await-in-loop -- one file at a time keeps disk reads sequential
    const actual = await entrySha256(zipPath, e);
    out.files.push({ path: f.path, expected: f.sha256, actual, size: e.size, ok: actual === f.sha256 && e.size === f.size });
  }
  out.unlisted = entries.map((e) => e.name).filter((n) => !listed.has(n) && !UNLISTED.has(n));
  out.ok = out.signatureOk && !out.missing.length && !out.unlisted.length && out.files.every((f) => f.ok);
  return out;
}

module.exports = { MANIFEST, SIGNATURE, PUBLIC_KEY, buildManifest, sign, verifySignature, fingerprint, verifyPack };
