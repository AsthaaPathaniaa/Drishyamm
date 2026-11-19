'use strict';

// Closing a breach out — "someone looked at this and dealt with it" — was kept
// in the operator's own browser (localStorage, see the frontend's breach-model
// before this shipped). So a supervisor who resolved twenty overnight
// intrusions had resolved nothing as far as the day shift, another machine or
// a second tab was concerned, and the log could not be used as a handover.
//
// Two columns, matching the pair already beside them for the acknowledgement:
// WHEN it was closed and WHO closed it. Reports have to be able to say
// "resolved by Suresh", not just "resolved" (same reasoning as migration 033).
//
// A resolution always implies an acknowledgement, so `resolved_at` is only
// ever set together with `acknowledged_at`; the API enforces that, not the
// schema, because the two can also be set independently by older rows.
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('ai_events');
    if (!table.resolved_at) {
      await queryInterface.addColumn('ai_events', 'resolved_at', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
    if (!table.resolved_by) {
      await queryInterface.addColumn('ai_events', 'resolved_by', {
        // CHAR(36) to match users.id, which is CHAR(36) utf8mb4_unicode_ci.
        // Sequelize.UUID renders as CHAR(36) BINARY and trips errno 150 — the
        // same collation trap AIEvent's own comment records.
        type: Sequelize.STRING(36),
        allowNull: true,
      });
    }
    // The No-entry list filters on "still open" / "resolved" for one account
    // over a date range, which is the same access pattern migration 022 added
    // the acknowledgement index for.
    const [rows] = await queryInterface.sequelize.query(
      'SHOW INDEX FROM ai_events WHERE Key_name = ?', { replacements: ['ix_ai_events_user_resolved'] });
    if (!rows.length) {
      await queryInterface.sequelize.query(
        'ALTER TABLE ai_events ADD INDEX ix_ai_events_user_resolved (user_id, resolved_at), ALGORITHM=INPLACE, LOCK=NONE');
    }
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SHOW INDEX FROM ai_events WHERE Key_name = ?', { replacements: ['ix_ai_events_user_resolved'] });
    if (rows.length) await queryInterface.removeIndex('ai_events', 'ix_ai_events_user_resolved');
    const table = await queryInterface.describeTable('ai_events');
    if (table.resolved_at) await queryInterface.removeColumn('ai_events', 'resolved_at');
    if (table.resolved_by) await queryInterface.removeColumn('ai_events', 'resolved_by');
  },
};
