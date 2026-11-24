// One Ed25519 signing key per organisation (tenant) for evidence packs.
// Created on first use; the private key is stored encrypted with the same
// AES-256-GCM scheme as camera passwords (utils/fieldCrypto, CAMERA_CRED_KEY).
const crypto = require('node:crypto');
const logger = require('../../config/logger');
const { encrypt, decrypt, enabled } = require('../../utils/fieldCrypto');
const { fingerprint } = require('./manifest');

async function getSigningKey(tenantId) {
  if (!tenantId) throw new Error('no organisation to sign for');
  const { EvidenceKey } = require('../../models');
  let row = await EvidenceKey.findByPk(tenantId);
  if (!row) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    if (!enabled()) logger.warn('evidence: CAMERA_CRED_KEY is not set, the signing key is stored unencrypted');
    [row] = await EvidenceKey.findOrCreate({
      where: { tenantId },
      defaults: { tenantId, publicKey: pub, privateKey: encrypt(priv), fingerprint: fingerprint(pub) },
    });
    logger.info('evidence: signing key ready', { tenantId, fingerprint: row.fingerprint });
  }
  return { publicKeyPem: row.publicKey, privateKeyPem: decrypt(row.privateKey), fingerprint: row.fingerprint };
}

/** Public keys this server has signed with (for "made here" checks). */
async function knownFingerprints(tenantId) {
  const { EvidenceKey } = require('../../models');
  const row = await EvidenceKey.findByPk(tenantId, { attributes: ['fingerprint'] });
  return row ? [row.fingerprint] : [];
}

module.exports = { getSigningKey, knownFingerprints };
