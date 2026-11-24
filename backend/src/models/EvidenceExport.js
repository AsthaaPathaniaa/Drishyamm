const { DataTypes } = require('sequelize');

/**
 * EvidenceExport — one sealed evidence pack and its export log entry
 * (investigation toolkit I-5, migration 040). The row outlives the ZIP: it is
 * the record of who exported what, when and why.
 */
module.exports = (sequelize) => {
  const json = (field) => ({
    get() {
      const v = this.getDataValue(field);
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
  });

  return sequelize.define(
    'EvidenceExport',
    {
      id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId:       { type: DataTypes.UUID, allowNull: false },
      userId:         { type: DataTypes.UUID, allowNull: false },
      createdBy:      { type: DataTypes.UUID, allowNull: true },
      createdByName:  { type: DataTypes.STRING(120), allowNull: true },
      caseId:         { type: DataTypes.UUID, allowNull: true },
      monitorId:      { type: DataTypes.STRING(64), allowNull: false },
      cameraName:     { type: DataTypes.STRING(160), allowNull: true },
      startAt:        { type: DataTypes.DATE, allowNull: false },
      endAt:          { type: DataTypes.DATE, allowNull: false },
      reason:         { type: DataTypes.TEXT, allowNull: false },
      status:         { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'building' },
      error:          { type: DataTypes.STRING(500), allowNull: true },
      trackIds:       { type: DataTypes.JSON, allowNull: true, ...json('trackIds') },
      files:          { type: DataTypes.JSON, allowNull: true, ...json('files') },
      manifestSha256: { type: DataTypes.CHAR(64), allowNull: true },
      signature:      { type: DataTypes.TEXT, allowNull: true },
      keyFingerprint: { type: DataTypes.STRING(64), allowNull: true },
      zipPath:        { type: DataTypes.STRING(255), allowNull: true },
      zipSize:        { type: DataTypes.BIGINT, allowNull: true },
      zipSha256:      { type: DataTypes.CHAR(64), allowNull: true },
      ip:             { type: DataTypes.STRING(64), allowNull: true },
      downloads:      { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'evidence_exports', underscored: true },
  );
};
