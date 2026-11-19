/**
 * Safety net for saved camera reference pictures: a bucket lifecycle rule that
 * deletes snapshots/ objects SNAPSHOT_MAX_AGE_DAYS + 1 days (default 15) after
 * they were last written. The hourly sweep in liveSnapshot.service normally
 * replaces or deletes them at 14 days; this only matters if the sweep stops.
 *
 * A bucket has ONE lifecycle configuration and PUT replaces all of it, so this
 * reads the current rules, swaps in only the rule with our ID, and writes the
 * merged set back. Dry run by default: it prints what it would write.
 *
 *   node scripts/s3-snapshot-lifecycle.js           # show current + merged rules
 *   node scripts/s3-snapshot-lifecycle.js --apply   # write them
 *
 * Uses the app's S3_* settings (same bucket and credentials as the backend).
 * If the bucket is managed by the provider's console instead, create the rule
 * there: prefix "snapshots/", expire current versions after 15 days.
 */

const crypto = require('crypto');
const {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');
const s3 = require('../src/services/s3.service');

const RULE_ID = 'drishyam-snapshots-expiry';
const days = (parseInt(process.env.SNAPSHOT_MAX_AGE_DAYS, 10) || 14) + 1;
const apply = process.argv.includes('--apply');

async function currentRules() {
  try {
    const res = await s3.client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: s3.bucket }));
    return res.Rules || [];
  } catch (err) {
    if (err.name === 'NoSuchLifecycleConfiguration' || err.Code === 'NoSuchLifecycleConfiguration') return [];
    throw err;
  }
}

async function main() {
  const existing = await currentRules();
  const rule = {
    ID: RULE_ID,
    Status: 'Enabled',
    Filter: { Prefix: 'snapshots/' },
    Expiration: { Days: days },
  };
  const rules = [...existing.filter((r) => r.ID !== RULE_ID), rule];

  console.log(`bucket ${s3.bucket}: ${existing.length} rule(s) now`);
  console.log(JSON.stringify(rules, null, 2));
  if (!apply) {
    console.log('\ndry run — pass --apply to write these rules');
    return;
  }
  const put = new PutBucketLifecycleConfigurationCommand({
    Bucket: s3.bucket,
    LifecycleConfiguration: { Rules: rules },
  });
  // S3-compatible stores (MinIO, and others) require Content-MD5 on this call;
  // SDK v3 now sends only a CRC32 checksum, which they reject.
  put.middlewareStack.add((next) => async (args) => {
    if (typeof args.request.body === 'string') {
      args.request.headers['content-md5'] = crypto.createHash('md5').update(args.request.body).digest('base64');
    }
    return next(args);
  }, { step: 'build', name: 'contentMd5' });
  await s3.client.send(put);
  const after = await currentRules();
  console.log(`\nwritten; bucket now has ${after.length} rule(s):`, after.map((r) => r.ID).join(', '));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('lifecycle update failed:', err.name, err.message);
  process.exit(1);
});
