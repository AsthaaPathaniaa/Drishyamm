// Evidence export (investigation toolkit I-5). Opt-in feature `evidence_export`
// (off for every account until an admin switches it on), AI tier not needed:
// a sealed clip is useful without Smart Search.
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const withAccount = require('../middleware/withAccount');
const requireFeature = require('../middleware/requireFeature');
const ctrl = require('../controllers/evidence.controller');

const router = Router();
router.use(authenticate);
router.use(withAccount);   // organisation (account owner) + name for sub-users
router.use(requireFeature('evidence_export'));

router.get ('/',             ctrl.list);
router.post('/',             ctrl.create);
router.post('/verify',       ctrl.verify);
router.get ('/:id',          ctrl.get);
router.get ('/:id/download', ctrl.download);

module.exports = router;
