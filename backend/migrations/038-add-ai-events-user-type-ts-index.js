'use strict';

// The restricted-zone endpoints (GET /api/ai/zone-breaches and its CSV export)
// ask for one account's rows of ONE event type over a date range, newest
// first. The existing indexes lead with user_id but carry ts next, so that
// query had to read every event the account ever recorded inside the window —
// including the face detections, which outnumber breaches by orders of
// magnitude — and filter event_type row by row. With event_type between them
// it is a range scan over just the breaches, and the COUNT(*) behind the
// pagination total is served from the index alone.
const INDEX = 'ix_ai_events_user_type_ts';

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SHOW INDEX FROM ai_events WHERE Key_name = ?', { replacements: [INDEX] });
    if (rows.length) return;
    // INPLACE/LOCK=NONE: ai_events is written continuously by the alert
    // forwarder, and the table is large on live accounts.
    await queryInterface.sequelize.query(
      `ALTER TABLE ai_events ADD INDEX ${INDEX} (user_id, event_type, ts), ALGORITHM=INPLACE, LOCK=NONE`);
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SHOW INDEX FROM ai_events WHERE Key_name = ?', { replacements: [INDEX] });
    if (!rows.length) return;
    await queryInterface.removeIndex('ai_events', INDEX);
  },
};
