// Cases (investigation toolkit I-4). Opt-in feature `investigate_cases`: off
// for every account until an admin switches it on. No AI tier needed.
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const withAccount = require('../middleware/withAccount');
const requireFeature = require('../middleware/requireFeature');
const ctrl = require('../controllers/cases.controller');

const router = Router();
router.use(authenticate);
router.use(withAccount);   // organisation (account owner) + name for sub-users
router.use(requireFeature('investigate_cases'));

router.get   ('/',                             ctrl.list);
router.post  ('/',                             ctrl.create);
router.get   ('/people',                       ctrl.people);
router.get   ('/:id',                          ctrl.get);
router.patch ('/:id',                          ctrl.update);
router.post  ('/:id/items',                    ctrl.addItem);
router.delete('/:id/items/:itemId',            ctrl.removeItem);
router.post  ('/:id/items/:itemId/keep',       ctrl.keepItem);
router.get   ('/:id/items/:itemId/footage',    ctrl.keptFootage);
router.put   ('/:id/members',                  ctrl.setMember);
router.delete('/:id/members/:userId',          ctrl.removeMember);

module.exports = router;
