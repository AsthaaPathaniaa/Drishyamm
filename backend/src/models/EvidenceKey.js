const { DataTypes } = require('sequelize');

/**
 * EvidenceKey — the organisation's Ed25519 signing key for evidence packs
 * (migration 040). `privateKey` is stored encrypted (utils/fieldCrypto); use
 * services/evidence/keys.js, never this model directly.
 */
module.exports = (sequelize) => sequelize.define(
  'EvidenceKey',
  {
    tenantId:    { type: DataTypes.UUID, primaryKey: true },
    publicKey:   { type: DataTypes.TEXT, allowNull: false },
    privateKey:  { type: DataTypes.TEXT, allowNull: false },
    fingerprint: { type: DataTypes.STRING(64), allowNull: false },
  },
  { tableName: 'evidence_keys', underscored: true },
);
