'use strict';

/**
 * Write every AI feature flag out, so a camera's settings say what is running.
 *
 * Each flag shipped after cameras already existed and had to change nothing
 * that was already running, which produced two opposite defaults for "absent":
 * ON for the features every camera already did (faceRecognition,
 * journeyMapping, unknownAlerts, watchlistAlerts) and OFF for the detectors
 * that cost GPU per camera (activityMonitoring, zoneBodyDetection,
 * headcount.enabled). Both were right at the time. The cost of keeping them is
 * that you cannot read a camera's row and know what is on: you have to know
 * which of the two lists each flag is on.
 *
 * This writes the EFFECTIVE value -- exactly what every reader resolves today,
 * from the one table in services/aiFlags.js -- onto every camera. So:
 *
 *   NOTHING CHANGES BEHAVIOURALLY. Every camera keeps doing precisely what it
 *   was doing. A camera with faceRecognition absent gets `true`, which is what
 *   `faceRecognition !== false` already returned for it; one with
 *   zoneBodyDetection absent gets `false`, which is what `=== true` already
 *   returned. The flags become readable, not different.
 *
 * Cameras already fully explicit are SKIPPED, not rewritten, so the row count
 * this reports is the real size of the ambiguity.
 *
 * Idempotent: running it twice updates nothing the second time. Chunked,
 * because `settings` is a JSON column and an account can carry thousands of
 * cameras; one UPDATE per row, no table lock, safe to run on a live server.
 *
 * `down` is deliberately a no-op -- see the bottom of this file.
 */

const CHUNK = 200;

// Required lazily inside up() so the migration runner does not need the whole
// service graph loaded just to list migrations.
function flagHelpers() {
  // eslint-disable-next-line global-require
  return require('../src/services/aiFlags');
}

module.exports = {
  async up(queryInterface) {
    const { explicitSettings } = flagHelpers();
    const sequelize = queryInterface.sequelize;

    let offset = 0;
    let scanned = 0;
    let updated = 0;

    for (;;) {
      const [rows] = await sequelize.query(
        'SELECT id, settings FROM cameras ORDER BY id LIMIT ? OFFSET ?',
        { replacements: [CHUNK, offset] },
      );
      if (!rows.length) break;

      for (const row of rows) {
        scanned += 1;
        // mysql2 returns a JSON column already parsed; a TEXT column, or an
        // older driver, hands back a string. Accept both, and leave a row
        // whose JSON cannot be read alone rather than replacing it.
        let settings = row.settings;
        if (typeof settings === 'string') {
          try { settings = JSON.parse(settings); } catch { continue; }
        }
        // A camera with no settings at all is left alone. Writing defaults
        // onto it would turn a never-configured camera into a configured one
        // that happens to be all-off, and `settings: null` already reads as
        // every default through aiFlags.
        if (!settings || typeof settings !== 'object') continue;

        const next = explicitSettings(settings);
        if (!next) continue;            // already explicit

        await sequelize.query(
          'UPDATE cameras SET settings = ? WHERE id = ?',
          { replacements: [JSON.stringify(next), row.id] },
        );
        updated += 1;
      }

      offset += rows.length;
      if (rows.length < CHUNK) break;
    }

    // eslint-disable-next-line no-console
    console.log(`040: ${updated} of ${scanned} cameras had ambiguous AI flags; now explicit.`);
  },

  async down() {
    // Nothing to undo, and nothing that COULD be undone correctly.
    //
    // The flags this wrote are the values every reader already resolved, so
    // there is no previous behaviour to restore. Deleting them again would
    // mean guessing which cameras had been explicit BEFORE the migration ran
    // -- information this does not keep, because keeping it would mean storing
    // a second copy of the thing the migration exists to remove.
    //
    // Rolling back the CODE is safe on its own: the readers still resolve an
    // explicit boolean to itself, so a reverted deploy reads these rows
    // exactly as it read the ambiguous ones.
  },
};
