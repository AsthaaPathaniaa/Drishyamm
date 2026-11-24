const { DataTypes } = require('sequelize');

/** An imported video file, indexed like a camera (investigation I-7, migration 042). */
module.exports = (sequelize) => {
  const json = (field) => ({
    get() {
      const v = this.getDataValue(field);
      return typeof v === 'string' ? JSON.parse(v) : v;
    },
  });
  return sequelize.define('VideoImport', {
    id:                  { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenantId:            { type: DataTypes.UUID, allowNull: false },
    userId:              { type: DataTypes.UUID, allowNull: false },
    uploadedBy:          { type: DataTypes.UUID, allowNull: true },
    uploadedByName:      { type: DataTypes.STRING(120), allowNull: true },
    title:               { type: DataTypes.STRING(200), allowNull: false },
    place:               { type: DataTypes.STRING(200), allowNull: true },
    source:              { type: DataTypes.STRING(32), allowNull: true },
    originalName:        { type: DataTypes.STRING(255), allowNull: false },
    path:                { type: DataTypes.STRING(400), allowNull: false },
    size:                { type: DataTypes.BIGINT, allowNull: false },
    sha256:              { type: DataTypes.CHAR(64), allowNull: false },
    mime:                { type: DataTypes.STRING(80), allowNull: true },
    recordedStart:       { type: DataTypes.DATE, allowNull: false },
    recordedStartSource: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'user' },
    durationS:           { type: DataTypes.FLOAT, allowNull: true },
    videoInfo:           { type: DataTypes.JSON, allowNull: true, ...json('videoInfo') },
    caseId:              { type: DataTypes.UUID, allowNull: true },
    status:              { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'queued' },
    progress:            { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    tracks:              { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    error:               { type: DataTypes.STRING(500), allowNull: true },
    indexedAt:           { type: DataTypes.DATE, allowNull: true },
    indexSeconds:        { type: DataTypes.FLOAT, allowNull: true },
  }, { tableName: 'video_imports', underscored: true });
};
