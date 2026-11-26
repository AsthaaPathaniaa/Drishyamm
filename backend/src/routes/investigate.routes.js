// Investigation toolkit API (docs/investigation). Smart Search only for now.
// Opt-in: `investigate_search` is off for every account until an admin
// switches it on (featureCatalog `optIn`), and the AI tier is required.
const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const authenticate = require('../middleware/authenticate');
const withAccount = require('../middleware/withAccount');
const requireAiCapability = require('../middleware/requireAiCapability');
const requireFeature = require('../middleware/requireFeature');
const ctrl = require('../controllers/investigate.controller');

const router = Router();

// Each search runs a text/image model and a vector search: 30 a minute per
// user is plenty for a person typing.
const searchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `investigate:${req.user?.id || req.ip}`,
  message: { success: false, message: 'Too many searches. Wait a minute and try again.' },
});

router.use(authenticate);
router.use(withAccount);   // organisation (account owner) + name for sub-users
router.use(requireAiCapability);
router.use(requireFeature('investigate_search'));

router.get ('/status',              ctrl.status);
router.post('/search',              searchLimiter, ctrl.search);
router.post('/search/photo',        searchLimiter, ctrl.searchPhoto);
router.get ('/tracks/:id',          ctrl.getTrack);
router.get ('/tracks/:id/crop',     ctrl.getTrackCrop);
router.get ('/tracks/:id/companions', ctrl.companions);   // Associations (phase 4)
// Click to track (I-3)
router.post('/track-at',            ctrl.trackAt);
router.post('/journey',             searchLimiter, ctrl.journey);
router.post('/journey/review',      ctrl.review);
router.post('/journey/stitch',      searchLimiter, ctrl.stitch);
router.get ('/journey/stitch/:jobId',       ctrl.stitchStatus);
router.get ('/journey/stitch/:jobId/video', ctrl.stitchVideo);
// File import (I-7)
const imports = require('../controllers/imports.controller');
router.get   ('/imports',           imports.list);
router.post  ('/imports',           imports.create);
router.get   ('/imports/:id',       imports.get);
router.post  ('/imports/:id/index', imports.reindex);
router.get   ('/imports/:id/video', imports.video);
router.delete('/imports/:id',       imports.remove);
// Ask Drishyam (I-8) and AI Summaries (I-9): their own opt-in switch.
router.post('/ask',     requireFeature('investigate_ask'), searchLimiter, ctrl.ask);
router.get ('/summary', requireFeature('investigate_ask'), ctrl.summary);
// Audio Search (phase 4): its own opt-in switch (speech is sensitive)
router.post('/speech/transcribe',        requireFeature('investigate_audio'), searchLimiter, ctrl.transcribe);
router.get ('/speech/jobs/:jobId',       requireFeature('investigate_audio'), ctrl.transcribeStatus);
router.get ('/speech',                   requireFeature('investigate_audio'), searchLimiter, ctrl.speechSearch);
// Video synopsis (phase 4)
router.post('/synopsis',                 searchLimiter, ctrl.synopsis);
router.get ('/synopsis/:jobId',          ctrl.synopsisStatus);
router.get ('/synopsis/:jobId/video',    ctrl.synopsisVideo);
// Smart Skim (I-6)
router.get ('/activity',            ctrl.activity);

module.exports = router;
