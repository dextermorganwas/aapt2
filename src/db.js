'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const logger = require('./logger');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('movie','series')),
  tmdb_id TEXT,
  imdb_id TEXT,
  tvdb_id TEXT,
  title TEXT,
  year TEXT,
  original_language TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_tmdb ON media(type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_imdb ON media(imdb_id) WHERE imdb_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_tvdb ON media(type, tvdb_id) WHERE tvdb_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS art (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  art_type TEXT NOT NULL CHECK(art_type IN ('poster','backdrop','logo')),
  source TEXT NOT NULL,
  source_ref TEXT,
  source_url TEXT,
  local_path TEXT,
  content_type TEXT,
  language TEXT,
  is_override INTEGER DEFAULT 0,
  cache_forever INTEGER DEFAULT 0,
  fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  selection_stage TEXT,
  selection_reason TEXT,
  resolver_version INTEGER,
  UNIQUE(media_id, art_type)
);

CREATE TABLE IF NOT EXISTS tpdb_state (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'never',
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  match_posters_page_id TEXT,
  matcher_version INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
  art_type TEXT,
  requested_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_request_log_media ON request_log(media_id);
`);

// Migrate databases created by earlier versions.
ensureColumn('art', 'selection_stage', 'TEXT');
ensureColumn('art', 'selection_reason', 'TEXT');
ensureColumn('art', 'resolver_version', 'INTEGER');
ensureColumn('tpdb_state', 'matcher_version', 'INTEGER');

logger.info(`SQLite database ready at ${config.dbPath}`);

function findMedia({ type, tmdbId, imdbId, tvdbId }) {
  if (tmdbId) {
    const row = db.prepare(`SELECT * FROM media WHERE type = ? AND tmdb_id = ?`).get(type, String(tmdbId));
    if (row) return row;
  }
  if (imdbId) {
    const row = db.prepare(`SELECT * FROM media WHERE imdb_id = ?`).get(String(imdbId));
    if (row) return row;
  }
  if (tvdbId) {
    const row = db.prepare(`SELECT * FROM media WHERE type = ? AND tvdb_id = ?`).get(type, String(tvdbId));
    if (row) return row;
  }
  return null;
}

function findOrCreateMedia({ type, tmdbId, imdbId, tvdbId }) {
  let row = findMedia({ type, tmdbId, imdbId, tvdbId });
  if (!row) {
    const info = db.prepare(`INSERT INTO media (type, tmdb_id, imdb_id, tvdb_id) VALUES (?, ?, ?, ?)`)
      .run(type, tmdbId ? String(tmdbId) : null, imdbId ? String(imdbId) : null, tvdbId ? String(tvdbId) : null);
    return db.prepare(`SELECT * FROM media WHERE id = ?`).get(info.lastInsertRowid);
  }
  const patch = {};
  if (tmdbId && !row.tmdb_id) patch.tmdb_id = String(tmdbId);
  if (imdbId && !row.imdb_id) patch.imdb_id = String(imdbId);
  if (tvdbId && !row.tvdb_id) patch.tvdb_id = String(tvdbId);
  if (Object.keys(patch).length) {
    const sets = Object.keys(patch).map((k) => `${k}=@${k}`).join(', ');
    try {
      db.prepare(`UPDATE media SET ${sets}, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({ ...patch, id: row.id });
      row = db.prepare(`SELECT * FROM media WHERE id = ?`).get(row.id);
    } catch (e) {
      logger.warn('media id backfill skipped (conflict)', e.message);
    }
  }
  return row;
}

function updateMediaMeta(mediaId, { title, year, originalLanguage }) {
  db.prepare(`UPDATE media SET title=COALESCE(@title,title), year=COALESCE(@year,year),
    original_language=COALESCE(@originalLanguage,original_language), updated_at=CURRENT_TIMESTAMP WHERE id=@mediaId`)
    .run({ mediaId, title: title || null, year: year || null, originalLanguage: originalLanguage || null });
}
function getMediaById(id) { return db.prepare(`SELECT * FROM media WHERE id=?`).get(id); }
function searchMedia(query, limit=50) {
  const like=`%${query}%`;
  return db.prepare(`SELECT * FROM media WHERE title LIKE ? OR tmdb_id=? OR imdb_id=? OR tvdb_id=? ORDER BY updated_at DESC LIMIT ?`).all(like, query, query, query, limit);
}
function listMedia({limit=100, offset=0}={}) { return db.prepare(`SELECT * FROM media ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset); }
function countMedia() { return db.prepare(`SELECT COUNT(*) c FROM media`).get().c; }

function getArt(mediaId, artType) { return db.prepare(`SELECT * FROM art WHERE media_id=? AND art_type=?`).get(mediaId, artType); }
function getArtForMedia(mediaId) { return db.prepare(`SELECT * FROM art WHERE media_id=? ORDER BY art_type`).all(mediaId); }

function upsertArt(mediaId, artType, data) {
  const existing = getArt(mediaId, artType);
  const payload = {
    mediaId, artType, source:data.source, sourceRef:data.sourceRef||null, sourceUrl:data.sourceUrl||null,
    localPath:data.localPath||null, contentType:data.contentType||null, language:data.language||null,
    isOverride:data.isOverride?1:0, cacheForever:data.cacheForever?1:0, expiresAt:data.expiresAt||null,
    selectionStage:data.selectionStage||null, selectionReason:data.selectionReason||null,
    resolverVersion:Number.isFinite(data.resolverVersion) ? data.resolverVersion : null,
  };
  if (existing) {
    db.prepare(`UPDATE art SET source=@source,source_ref=@sourceRef,source_url=@sourceUrl,local_path=@localPath,
      content_type=@contentType,language=@language,is_override=@isOverride,cache_forever=@cacheForever,
      fetched_at=CURRENT_TIMESTAMP,expires_at=@expiresAt,selection_stage=@selectionStage,selection_reason=@selectionReason,resolver_version=@resolverVersion
      WHERE media_id=@mediaId AND art_type=@artType`).run(payload);
  } else {
    db.prepare(`INSERT INTO art(media_id,art_type,source,source_ref,source_url,local_path,content_type,language,
      is_override,cache_forever,fetched_at,expires_at,selection_stage,selection_reason,resolver_version)
      VALUES(@mediaId,@artType,@source,@sourceRef,@sourceUrl,@localPath,@contentType,@language,
      @isOverride,@cacheForever,CURRENT_TIMESTAMP,@expiresAt,@selectionStage,@selectionReason,@resolverVersion)`).run(payload);
  }
  return getArt(mediaId, artType);
}

function deleteArt(mediaId, artType) { db.prepare(`DELETE FROM art WHERE media_id=? AND art_type=?`).run(mediaId, artType); }

function getTpdbState(mediaId) { return db.prepare(`SELECT * FROM tpdb_state WHERE media_id=?`).get(mediaId); }
function upsertTpdbState(mediaId, patch) {
  const now = new Date().toISOString();
  const current = getTpdbState(mediaId);
  const data = {
    mediaId,
    status: patch.status ?? current?.status ?? 'never',
    lastAttemptAt: patch.lastAttemptAt ?? current?.last_attempt_at ?? null,
    nextAttemptAt: patch.nextAttemptAt ?? current?.next_attempt_at ?? null,
    failCount: patch.failCount ?? current?.fail_count ?? 0,
    lastError: patch.lastError ?? current?.last_error ?? null,
    matchPostersPageId: patch.matchPostersPageId ?? current?.match_posters_page_id ?? null,
    matcherVersion: config.tpdbMatcherVersion,
    updatedAt: now,
  };
  db.prepare(`INSERT INTO tpdb_state(media_id,status,last_attempt_at,next_attempt_at,fail_count,last_error,match_posters_page_id,matcher_version,updated_at)
    VALUES(@mediaId,@status,@lastAttemptAt,@nextAttemptAt,@failCount,@lastError,@matchPostersPageId,@matcherVersion,@updatedAt)
    ON CONFLICT(media_id) DO UPDATE SET status=excluded.status,last_attempt_at=excluded.last_attempt_at,
      next_attempt_at=excluded.next_attempt_at,fail_count=excluded.fail_count,last_error=excluded.last_error,
      match_posters_page_id=excluded.match_posters_page_id,matcher_version=excluded.matcher_version,updated_at=excluded.updated_at`).run(data);
  return getTpdbState(mediaId);
}
function tpdbIsDue(mediaId) {
  const s = getTpdbState(mediaId);
  if (!s || s.matcher_version !== config.tpdbMatcherVersion || !s.next_attempt_at) return true;
  return Date.now() >= new Date(s.next_attempt_at).getTime();
}
function resetTpdbState(mediaId) { db.prepare(`DELETE FROM tpdb_state WHERE media_id=?`).run(mediaId); }
function listDueTpdb(limit=100) {
  return db.prepare(`SELECT m.* FROM media m LEFT JOIN tpdb_state s ON s.media_id=m.id
    LEFT JOIN art a ON a.media_id=m.id AND a.art_type='poster'
    WHERE (a.id IS NULL OR a.source <> 'theposterdb')
      AND (s.matcher_version IS NULL OR s.matcher_version <> ? OR s.next_attempt_at IS NULL OR s.next_attempt_at <= datetime('now'))
    ORDER BY COALESCE(s.next_attempt_at,'1970-01-01') ASC LIMIT ?`).all(config.tpdbMatcherVersion, limit);
}

function logRequest(mediaId, artType) { db.prepare(`INSERT INTO request_log(media_id,art_type) VALUES(?,?)`).run(mediaId,artType); }
function recentRequestCounts(limit=200) {
  return db.prepare(`SELECT media_id,COUNT(*) hits,MAX(requested_at) last_requested FROM request_log GROUP BY media_id ORDER BY last_requested DESC LIMIT ?`).all(limit);
}

module.exports={raw:db,findMedia,findOrCreateMedia,updateMediaMeta,getMediaById,searchMedia,listMedia,countMedia,getArt,getArtForMedia,upsertArt,deleteArt,
  getTpdbState,upsertTpdbState,resetTpdbState,tpdbIsDue,listDueTpdb,logRequest,recentRequestCounts};
