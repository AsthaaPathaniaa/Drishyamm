'use strict';

/**
 * Cases (investigation toolkit I-4): one workspace per incident.
 *
 * cases        — the incident. `number` is per account (Case #0142). `legal_hold`
 *                keeps everything pinned: tracks are held in the AI index
 *                (retention skips them) and footage is copied off the recorder.
 * case_members — who can open it: owner / editor / viewer, from the same account.
 * case_items   — what is pinned: a person (track), a clip, a journey, a note, an
 *                evidence pack. Footage items can be KEPT: copied from the NVR
 *                into case storage before the NVR overwrites it, SHA-256 hashed
 *                while written (`preserved_*`).
 * case_audit   — every view, add, remove, keep, export and membership change,
 *                with who and when. Append-only.
 *
 * `user_id` = the account owner (parent_user_id || id), like reports (033).
 * Raw CHAR(36) BINARY for UUID columns (errno-150 lesson, 008). Idempotent.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    const uuid = (allowNull = false) => ({ type: 'CHAR(36) BINARY', allowNull });
    const stamps = {
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    };

    if (!tables.includes('cases')) {
      await queryInterface.createTable('cases', {
        id: { ...uuid(), primaryKey: true },
        tenant_id: uuid(),
        user_id: uuid(),
        number: { type: Sequelize.INTEGER, allowNull: false },
        title: { type: Sequelize.STRING(160), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: true },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'open' },          // open | closed
        priority: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'normal' },      // low | normal | high
        tags: { type: Sequelize.JSON, allowNull: true },
        legal_hold: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        created_by: uuid(true),
        created_by_name: { type: Sequelize.STRING(120), allowNull: true },
        closed_at: { type: Sequelize.DATE, allowNull: true },
        ...stamps,
      });
      await queryInterface.addIndex('cases', ['user_id', 'number'], { unique: true, name: 'cases_user_number' });
      await queryInterface.addIndex('cases', ['user_id', 'status', 'updated_at'], { name: 'cases_user_status' });
    }

    if (!tables.includes('case_members')) {
      await queryInterface.createTable('case_members', {
        case_id: { ...uuid(), primaryKey: true },
        user_id: { ...uuid(), primaryKey: true },
        role: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'viewer' },        // owner | editor | viewer
        user_name: { type: Sequelize.STRING(120), allowNull: true },
        added_by: uuid(true),
        ...stamps,
      });
      await queryInterface.addIndex('case_members', ['user_id'], { name: 'case_members_user' });
    }

    if (!tables.includes('case_items')) {
      await queryInterface.createTable('case_items', {
        id: { ...uuid(), primaryKey: true },
        case_id: uuid(),
        // track | clip | journey | note | evidence
        type: { type: Sequelize.STRING(16), allowNull: false },
        monitor_id: { type: Sequelize.STRING(64), allowNull: true },
        camera_name: { type: Sequelize.STRING(160), allowNull: true },
        ts_from: { type: Sequelize.DATE, allowNull: true },
        ts_to: { type: Sequelize.DATE, allowNull: true },
        title: { type: Sequelize.STRING(200), allowNull: true },
        note: { type: Sequelize.TEXT, allowNull: true },
        // { trackId, score, stops: [...], evidenceId, ... }
        ref: { type: Sequelize.JSON, allowNull: true },
        // none | queued | keeping | kept | failed
        preserved_status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'none' },
        preserved_error: { type: Sequelize.STRING(500), allowNull: true },
        preserved_path: { type: Sequelize.STRING(255), allowNull: true },
        preserved_sha256: { type: 'CHAR(64)', allowNull: true },
        preserved_size: { type: Sequelize.BIGINT, allowNull: true },
        added_by: uuid(true),
        added_by_name: { type: Sequelize.STRING(120), allowNull: true },
        ...stamps,
      });
      await queryInterface.addIndex('case_items', ['case_id', 'ts_from'], { name: 'case_items_case_time' });
    }

    if (!tables.includes('case_audit')) {
      await queryInterface.createTable('case_audit', {
        id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
        case_id: uuid(),
        user_id: uuid(true),
        user_name: { type: Sequelize.STRING(120), allowNull: true },
        action: { type: Sequelize.STRING(48), allowNull: false },
        detail: { type: Sequelize.JSON, allowNull: true },
        at: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('case_audit', ['case_id', 'at'], { name: 'case_audit_case_at' });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map((t) => String(t).toLowerCase());
    for (const t of ['case_audit', 'case_items', 'case_members', 'cases']) {
      if (tables.includes(t)) await queryInterface.dropTable(t);
    }
  },
};
