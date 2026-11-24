// The access token carries only { id, email, role }. The investigation
// toolkit (Smart Search, evidence, cases) works per ORGANISATION: the AI
// tenant, the case library and the signing key all hang off the account owner
// (users.parent_user_id || users.id). Load that, and a display name, once per
// request so a sub-user lands in their organisation, not a tenant of their own.
const asyncHandler = require('./asyncHandler');
const AppError = require('../utils/AppError');

module.exports = asyncHandler(async (req, _res, next) => {
  if (!req.user?.id) throw new AppError('Not signed in.', 401);
  if (req.user.parentUserId === undefined) {
    const { User } = require('../models');
    const u = await User.findByPk(req.user.id, { attributes: ['id', 'parentUserId', 'name', 'username', 'email'] });
    if (!u) throw new AppError('Not signed in.', 401);
    req.user = {
      ...req.user,
      parentUserId: u.parentUserId || null,
      name: req.user.name || u.name || u.username || u.email || String(u.id),
    };
  }
  next();
});
