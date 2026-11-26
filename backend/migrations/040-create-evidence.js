'use strict';

/**
 * Evidence export (investigation toolkit I-5): a sealed, court-ready pack of
 * footage, and the log of every pack made.
 *
 * evidence_exports — one row per pack. Who made it, from which camera and
 *   time range, and WHY (free text, required: a pack without a reason is not
 *   made). The files in it with their SHA-256 and size, the SHA-256 of the
 *   manifest, and the Ed25519 signature over that manifest. The ZIP itself
 *   lives on disk under EVIDENCE_DIR; the row is the export log and stays
 *   after the file is deleted.
 *
 * evidence_keys — one Ed25519 key pair per organisation (tenant). The public
 *   key goes into every pack so anyone can verify it; the private key is
 *   stored encrypted (utils/fieldCrypto, CAMERA_CRED_KEY) and never leaves
 *   the backend.
 *
 * `user_id` is the account owner (users.parent_user_id || users.id), like
 * reports (033); `created_by` is who pressed Export. Raw CHAR(36) BINARY for
 * UUID columns (errno-150 lesson, migration 008). Idempotent.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());

    if (!tables.includes('evidence_keys')) {
      await queryInterface.createTable('evidence_keys', {
        tenant_id:   { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        public_key:  { type: Sequelize.TEXT, allowNull: false },            // PEM (SPKI)
        private_key: { type: Sequelize.TEXT, allowNull: false },            // PEM (PKCS8), encrypted
        fingerprint: { type: Sequelize.STRING(64), allowNull: false },      // SHA-256 of the public key DER
        created_at:  { type: Sequelize.DATE, allowNull: false },
        updated_at:  { type: Sequelize.DATE, allowNull: false },
      });
    }

    if (!tables.includes('evidence_exports')) {
      await queryInterface.createTable('evidence_exports', {
        id:          { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
        tenant_id:   { type: 'CHAR(36) BINARY', allowNull: false },
        user_id:     { type: 'CHAR(36) BINARY', allowNull: false },
        created_by:  { type: 'CHAR(36) BINARY', allowNull: true },
        created_by_name: { type: Sequelize.STRING(120), allowNull: true },
        case_id:     { type: 'CHAR(36) BINARY', allowNull: true },
        monitor_id:  { type: Sequelize.STRING(64), allowNull: false },
        camera_name: { type: Sequelize.STRING(160), allowNull: true },
        start_at:    { type: Sequelize.DATE, allowNull: false },
        end_at:      { type: Sequelize.DATE, allowNull: false },
        reason:      { type: Sequelize.TEXT, allowNull: false },
        // 'building' | 'ready' | 'failed'
        status:      { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'building' },
        error:       { type: Sequelize.STRING(500), allowNull: true },
        // Smart Search tracks the pack is about (optional).
        track_ids:   { type: Sequelize.JSON, allowNull: true },
        // [{ path, sha256, size, kind }]
        files:       { type: Sequelize.JSON, allowNull: true },
        manifest_sha256: { type: 'CHAR(64)', allowNull: true },
        signature:   { type: Sequelize.TEXT, allowNull: true },              // base64 Ed25519 over the manifest bytes
        key_fingerprint: { type: Sequelize.STRING(64), allowNull: true },
        zip_path:    { type: Sequelize.STRING(255), allowNull: true },
        zip_size:    { type: Sequelize.BIGINT, allowNull: true },
        zip_sha256:  { type: 'CHAR(64)', allowNull: true },
        ip:          { type: Sequelize.STRING(64), allowNull: true },
        downloads:   { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        created_at:  { type: Sequelize.DATE, allowNull: false },
        updated_at:  { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('evidence_exports', ['user_id', 'created_at'], { name: 'evidence_exports_user_created' });
      await queryInterface.addIndex('evidence_exports', ['tenant_id', 'created_at'], { name: 'evidence_exports_tenant_created' });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes('evidence_exports')) await queryInterface.dropTable('evidence_exports');
    if (tables.includes('evidence_keys')) await queryInterface.dropTable('evidence_keys');
  },
};
