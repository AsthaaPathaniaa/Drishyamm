const { DataTypes } = require('sequelize');

/**
 * Cases (investigation toolkit I-4, migration 041): Case, CaseMember, CaseItem,
 * CaseAudit. One file because they only make sense together; services/cases.js
 * is the only writer.
 */
module.exports = (sequelize) => {
  const json = (field) => ({
    get() {
      const v = this.getDataValue(field);
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
  });

  const Case = sequelize.define('Case', {
    id:            { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenantId:      { type: DataTypes.UUID, allowNull: false },
    userId:        { type: DataTypes.UUID, allowNull: false },
    number:        { type: DataTypes.INTEGER, allowNull: false },
    title:         { type: DataTypes.STRING(160), allowNull: false },
    description:   { type: DataTypes.TEXT, allowNull: true },
    status:        { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'open' },
    priority:      { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'normal' },
    tags:          { type: DataTypes.JSON, allowNull: true, ...json('tags') },
    legalHold:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdBy:     { type: DataTypes.UUID, allowNull: true },
    createdByName: { type: DataTypes.STRING(120), allowNull: true },
    closedAt:      { type: DataTypes.DATE, allowNull: true },
  }, { tableName: 'cases', underscored: true });

  const CaseMember = sequelize.define('CaseMember', {
    caseId:   { type: DataTypes.UUID, primaryKey: true },
    userId:   { type: DataTypes.UUID, primaryKey: true },
    role:     { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'viewer' },
    userName: { type: DataTypes.STRING(120), allowNull: true },
    addedBy:  { type: DataTypes.UUID, allowNull: true },
  }, { tableName: 'case_members', underscored: true });

  const CaseItem = sequelize.define('CaseItem', {
    id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    caseId:          { type: DataTypes.UUID, allowNull: false },
    type:            { type: DataTypes.STRING(16), allowNull: false },
    monitorId:       { type: DataTypes.STRING(64), allowNull: true },
    cameraName:      { type: DataTypes.STRING(160), allowNull: true },
    tsFrom:          { type: DataTypes.DATE, allowNull: true },
    tsTo:            { type: DataTypes.DATE, allowNull: true },
    title:           { type: DataTypes.STRING(200), allowNull: true },
    note:            { type: DataTypes.TEXT, allowNull: true },
    ref:             { type: DataTypes.JSON, allowNull: true, ...json('ref') },
    preservedStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'none' },
    preservedError:  { type: DataTypes.STRING(500), allowNull: true },
    preservedPath:   { type: DataTypes.STRING(255), allowNull: true },
    preservedSha256: { type: DataTypes.CHAR(64), allowNull: true },
    preservedSize:   { type: DataTypes.BIGINT, allowNull: true },
    addedBy:         { type: DataTypes.UUID, allowNull: true },
    addedByName:     { type: DataTypes.STRING(120), allowNull: true },
  }, { tableName: 'case_items', underscored: true });

  const CaseAudit = sequelize.define('CaseAudit', {
    id:       { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    caseId:   { type: DataTypes.UUID, allowNull: false },
    userId:   { type: DataTypes.UUID, allowNull: true },
    userName: { type: DataTypes.STRING(120), allowNull: true },
    action:   { type: DataTypes.STRING(48), allowNull: false },
    detail:   { type: DataTypes.JSON, allowNull: true, ...json('detail') },
    at:       { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, { tableName: 'case_audit', underscored: true, timestamps: false });

  return { Case, CaseMember, CaseItem, CaseAudit };
};
