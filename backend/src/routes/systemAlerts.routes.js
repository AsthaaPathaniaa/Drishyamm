const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const systemAlerts = require('../controllers/systemAlerts.controller');

const router = Router();
router.use(authenticate);
router.get('/system', systemAlerts.list);

module.exports = router;
