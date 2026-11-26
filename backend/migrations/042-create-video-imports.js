'use strict';

/**
 * video_imports (investigation toolkit I-7): videos brought in from a phone,
 * USB stick or another recorder, indexed like a camera.
 *
 * The SHA-256 is taken while the upload is written (forensic rule 12), before
 * anything reads the file. `recorded_start` dates the footage (from the file's
 * own metadata, or what the uploader said); every person found in it is placed
 * on that clock. Status follows the AI indexing job.
 *
 * `user_id` = account owner (parent_user_id || id). Raw CHAR(36) BINARY for
 * UUID columns (errno-150 lesson, 008). Idempotent.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes('video_imports')) return;
    await queryInterface.createTable('video_imports', {
      id: { type: 'CHAR(36) BINARY', primaryKey: true, allowNull: false },
      tenant_id: { type: 'CHAR(36) BINARY', allowNull: false },
      user_id: { type: 'CHAR(36) BINARY', allowNull: false },
      uploaded_by: { type: 'CHAR(36) BINARY', allowNull: true },
      uploaded_by_name: { type: Sequelize.STRING(120), allowNull: true },
      title: { type: Sequelize.STRING(200), allowNull: false },
      place: { type: Sequelize.STRING(200), allowNull: true },
      source: { type: Sequelize.STRING(32), allowNull: true },          // phone | usb | nvr | other
      original_name: { type: Sequelize.STRING(255), allowNull: false },
      path: { type: Sequelize.STRING(400), allowNull: false },
      size: { type: Sequelize.BIGINT, allowNull: false },
      sha256: { type: 'CHAR(64)', allowNull: false },
      mime: { type: Sequelize.STRING(80), allowNull: true },
      recorded_start: { type: Sequelize.DATE, allowNull: false },
      recorded_start_source: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'user' },   // file | user
      duration_s: { type: Sequelize.FLOAT, allowNull: true },
      video_info: { type: Sequelize.JSON, allowNull: true },
      case_id: { type: 'CHAR(36) BINARY', allowNull: true },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'queued' },   // queued | indexing | ready | failed
      progress: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 0 },
      tracks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      error: { type: Sequelize.STRING(500), allowNull: true },
      indexed_at: { type: Sequelize.DATE, allowNull: true },
      index_seconds: { type: Sequelize.FLOAT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('video_imports', ['user_id', 'created_at'], { name: 'video_imports_user_created' });
  },
  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    if (tables.includes('video_imports')) await queryInterface.dropTable('video_imports');
  },
};
