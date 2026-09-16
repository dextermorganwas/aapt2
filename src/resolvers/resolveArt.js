'use strict';
const config = require('../config');
const logger = require('../logger');
const db = require('../db');
const cache = require('../lib/cache');
const singleflight = require('../lib/singleflight');
const background = require('../jobs/backgroundQueue');
const langMap = require('../lib/langMap');
const tmdb = require('../providers/tmdb');
const tvdb = require('../providers/tvdb');
const tpdb = require('../providers/theposterdb');
const metahub = require('../providers/metahub');

const DAY_MS=86400000;
function ttlForSource(source){ if(source==='theposterdb')return null; if(source==='tmdb')return config.cacheTtlDaysTmdb*DAY_MS; if(source==='tvdb')return config.cacheTtlDaysTvdb*DAY_MS; if(source==='metahub')return config.cacheTtlDaysMetahub*DAY_MS; return config.cacheTtlDaysTmdb*DAY_MS; }
function isExpired(a){ if(!a)return true; if(a.is_override||a.cache_forever)return false; if(!a.expires_at)return false; return Date.now()>new Date(a.expires_at).getTime(); }
async function persistArt({mediaId,artType,source,sourceRef,sourceUrl,buffer,contentType,language,selectionStage,selectionReason}){
  const old=db.getArt(mediaId,artType);
  const localPath=cache.save({mediaId,artType,source,buffer,contentType,sourceUrl});
  const ttl=ttlForSource(source);
  const saved=db.upsertArt(mediaId,artType,{source,sourceRef,sourceUrl,localPath,contentType,language,isOverride:false,cacheForever:source==='theposterdb',expiresAt:ttl?new Date(Date.now()+ttl).toISOString():null,selectionStage,selectionReason,resolverVersion:config.tpdbMatcherVersion});
  if(old?.local_path && old.local_path!==saved.local_path) cache.remove(old.local_path);
  return saved;
}
async function buildContext({type,tmdbId,imdbId,tvdbId}){
  const ctx={type,tmdbId,imdbId,tvdbId,originalLanguage:null,title:null,year:null,tmdbDetails:null,tmdbImages:null};
  if(!ctx.tmdbId&&ctx.imdbId&&(config.tmdbApiKey||config.tmdbBearerToken)){
    const found=await tmdb.findByImdb(ctx.imdbId).catch(()=>null); const hit=type==='series'?found?.tv_results?.[0]:found?.movie_results?.[0]; if(hit)ctx.tmdbId=String(hit.id);
  }
  if(ctx.tmdbId){
    const [details,images]=await Promise.all([tmdb.getDetails({type,tmdbId:ctx.tmdbId}).catch(()=>null),tmdb.getImages({type,tmdbId:ctx.tmdbId}).catch(()=>null)]);
    ctx.tmdbDetails=details;ctx.tmdbImages=images;
    if(details){ctx.originalLanguage=details.original_language||null;ctx.title=details.title||details.name||null;ctx.year=(details.release_date||details.first_air_date||'').slice(0,4)||null;}
  }
  return ctx;
}
async function getTvdbData(ctx){ if(ctx._tvdb!==undefined)return ctx._tvdb; ctx._tvdb=await tvdb.getArtworks({type:ctx.type,tvdbId:ctx.tvdbId,imdbId:ctx.imdbId,tmdbId:ctx.tmdbId}).catch(()=>null); return ctx._tvdb; }
async function tmdbLangImages(ctx){ if(!ctx.tmdbId||!ctx.originalLanguage)return null; return tmdb.getImagesForLanguage({type:ctx.type,tmdbId:ctx.tmdbId,language:ctx.originalLanguage}).catch(()=>null); }

function scheduleTpdb(mediaRow,ctx,reason='request'){
  if(ctx.type!=='movie'&&ctx.type!=='series')return;
  const current=db.getArt(mediaRow.id,'poster');
  if(current?.is_override||current?.source==='theposterdb')return;
  if(!db.tpdbIsDue(mediaRow.id))return;
  const state=db.getTpdbState(mediaRow.id);
  const title=ctx.title||mediaRow.title; if(!title)return;
  // Mark it as in progress immediately so several simultaneous poster requests only queue one job.
  const next=new Date(Date.now()+Math.max(config.tpdbFirstAttemptDelaySeconds,5)*1000).toISOString();
  db.upsertTpdbState(mediaRow.id,{status:'queued',nextAttemptAt:next,lastError:null});
  background.schedule(`tpdb-${mediaRow.id}-${reason}`,()=>runTpdbBackground(mediaRow.id,ctx),Math.max(config.tpdbFirstAttemptDelaySeconds,0)*1000);
}

async function runTpdbBackground(mediaId,ctx){
  const mediaRow=db.getMediaById(mediaId); if(!mediaRow||db.getArt(mediaId,'poster')?.is_override||db.getArt(mediaId,'poster')?.source==='theposterdb')return;
  const now=new Date().toISOString();
  const before=db.getTpdbState(mediaId); const failCount=before?.fail_count||0;
  db.upsertTpdbState(mediaId,{status:'running',lastAttemptAt:now});
  try{
    const r=await tpdb.findEnglishOriginalPoster({title:ctx.title||mediaRow.title,year:ctx.year||mediaRow.year,mediaType:ctx.type,tmdbId:ctx.tmdbId||mediaRow.tmdb_id,imdbId:ctx.imdbId||mediaRow.imdb_id,tvdbId:ctx.tvdbId||mediaRow.tvdb_id,background:true});
    if(!r?.result){
      if(r?.status==='error') throw new Error('TPDB search failed');
      const nextMs=config.negativeCacheTtlHours*3600000;
      db.upsertTpdbState(mediaId,{status:'not_found',lastAttemptAt:now,nextAttemptAt:new Date(Date.now()+nextMs).toISOString(),failCount:0,lastError:null,matchPostersPageId:r?.postersPageId||null});
      logger.info(`ThePosterDB: no valid English/Original poster for media #${mediaId}; next background retry in ${config.negativeCacheTtlHours}h`);
      return;
    }
    const dl=await tpdb.downloadPoster(r.result.assetId,{background:true});
    if(!dl) throw new Error('TPDB asset download failed');
    const current=db.getArt(mediaId,'poster');
    if(current?.is_override||current?.source==='theposterdb')return;
    await persistArt({mediaId,artType:'poster',source:'theposterdb',sourceRef:r.result.assetId,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:r.result.language,selectionStage:'tpdb',selectionReason:`ThePosterDB: English · Show Cover/Movie · Original; asset ${r.result.assetId}`});
    db.upsertTpdbState(mediaId,{status:'found',lastAttemptAt:now,nextAttemptAt:null,failCount:0,lastError:null,matchPostersPageId:r.postersPageId});
    logger.info(`ThePosterDB backfill complete for media #${mediaId} (asset ${r.result.assetId})`);
  }catch(e){
    const nextSec=Math.min(config.tpdbRetryMaxSeconds,config.tpdbRetryBaseSeconds*Math.pow(2,failCount));
    db.upsertTpdbState(mediaId,{status:'error',lastAttemptAt:now,nextAttemptAt:new Date(Date.now()+nextSec*1000).toISOString(),failCount:failCount+1,lastError:String(e.message).slice(0,500)});
    logger.warn(`ThePosterDB background attempt failed for media #${mediaId}; retry in ${nextSec}s: ${e.message}`);
  }
}

async function restPoster(mediaRow,ctx){
  if(ctx.tmdbImages){const img=tmdb.pickFirst(ctx.tmdbImages,'posters','en');if(img){const dl=await tmdb.downloadImage(img.file_path,config.tmdbPosterSize);if(dl)return {source:'tmdb',sourceRef:img.file_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:'en',selectionStage:'tmdb_en',selectionReason:'TMDB English poster: first artwork in API response order'};}}
  const tv=await getTvdbData(ctx); if(tv){const a=tvdb.pickFirst(tv.posters,'eng');if(a){const dl=await tvdb.downloadImage(a.image);if(dl)return {source:'tvdb',sourceRef:a.id,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:'eng',selectionStage:'tvdb_en',selectionReason:'TVDB English poster: first artwork in API response order'};}}
  if(ctx.originalLanguage&&ctx.originalLanguage!=='en'){
    const li=await tmdbLangImages(ctx);const img=tmdb.pickFirst(li,'posters',ctx.originalLanguage);if(img){const dl=await tmdb.downloadImage(img.file_path,config.tmdbPosterSize);if(dl)return {source:'tmdb',sourceRef:img.file_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:ctx.originalLanguage,selectionStage:'tmdb_original',selectionReason:`TMDB original-language poster (${ctx.originalLanguage}): first artwork in API response order`};}
    if(tv){const lang=langMap.toTvdbLang(ctx.originalLanguage);const a=tvdb.pickFirst(tv.posters,lang);if(a){const dl=await tvdb.downloadImage(a.image);if(dl)return {source:'tvdb',sourceRef:a.id,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:lang,selectionStage:'tvdb_original',selectionReason:`TVDB ${lang} poster: first artwork in API response order`};}}
  }
  if(ctx.imdbId){const dl=await metahub.download('poster',ctx.imdbId);if(dl)return {source:'metahub',sourceRef:ctx.imdbId,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'metahub',selectionReason:'MetaHub IMDb poster fallback'};}
  if(ctx.tmdbDetails?.poster_path){const dl=await tmdb.downloadImage(ctx.tmdbDetails.poster_path,config.tmdbPosterSize);if(dl)return {source:'tmdb',sourceRef:ctx.tmdbDetails.poster_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tmdb_primary',selectionReason:'TMDB primary poster fallback from item details'};}
  if(tv?.primaryImage){const dl=await tvdb.downloadImage(tv.primaryImage);if(dl)return {source:'tvdb',sourceRef:'primary',sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tvdb_primary',selectionReason:'TVDB primary image fallback'};}
  return null;
}

async function resolvePoster(mediaRow,ctx){ scheduleTpdb(mediaRow,ctx,'poster-request'); return restPoster(mediaRow,ctx); }

async function resolveBackdrop(mediaRow,ctx){
  if(ctx.tmdbImages){const img=tmdb.pickFirst(ctx.tmdbImages,'backdrops',null);if(img){const dl=await tmdb.downloadImage(img.file_path,config.tmdbBackdropSize);if(dl)return {source:'tmdb',sourceRef:img.file_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tmdb_textless',selectionReason:'TMDB textless backdrop: first artwork with no language in API response order'};}}
  const tv=await getTvdbData(ctx); if(tv){const a=tvdb.pickFirstTextless(tv.backgrounds);if(a){const dl=await tvdb.downloadImage(a.image);if(dl)return {source:'tvdb',sourceRef:a.id,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tvdb_textless',selectionReason:'TVDB textless background: first artwork marked without text in API response order'};}}
  if(ctx.imdbId){const dl=await metahub.download('backdrop',ctx.imdbId);if(dl)return {source:'metahub',sourceRef:ctx.imdbId,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'metahub',selectionReason:'MetaHub IMDb background fallback'};}
  if(ctx.tmdbDetails?.backdrop_path){const dl=await tmdb.downloadImage(ctx.tmdbDetails.backdrop_path,config.tmdbBackdropSize);if(dl)return {source:'tmdb',sourceRef:ctx.tmdbDetails.backdrop_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tmdb_primary',selectionReason:'TMDB primary backdrop fallback from item details'};}
  if(tv?.primaryImage){const dl=await tvdb.downloadImage(tv.primaryImage);if(dl)return {source:'tvdb',sourceRef:'primary',sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tvdb_primary',selectionReason:'TVDB primary image fallback'};}
  return null;
}
async function resolveLogo(mediaRow,ctx){
  if(ctx.tmdbImages){const img=tmdb.pickFirst(ctx.tmdbImages,'logos','en');if(img){const dl=await tmdb.downloadImage(img.file_path,config.tmdbLogoSize);if(dl)return {source:'tmdb',sourceRef:img.file_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:'en',selectionStage:'tmdb_en',selectionReason:'TMDB English logo: first artwork in API response order'};}}
  const tv=await getTvdbData(ctx); if(tv){const a=tvdb.pickFirst(tv.logos,'eng');if(a){const dl=await tvdb.downloadImage(a.image);if(dl)return {source:'tvdb',sourceRef:a.id,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:'eng',selectionStage:'tvdb_en',selectionReason:'TVDB English logo: first artwork in API response order'};}}
  if(ctx.originalLanguage&&ctx.originalLanguage!=='en'){
    const li=await tmdbLangImages(ctx);const img=tmdb.pickFirst(li,'logos',ctx.originalLanguage);if(img){const dl=await tmdb.downloadImage(img.file_path,config.tmdbLogoSize);if(dl)return {source:'tmdb',sourceRef:img.file_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:ctx.originalLanguage,selectionStage:'tmdb_original',selectionReason:`TMDB original-language logo (${ctx.originalLanguage}): first artwork in API response order`};}
    if(tv){const lang=langMap.toTvdbLang(ctx.originalLanguage);const a=tvdb.pickFirst(tv.logos,lang);if(a){const dl=await tvdb.downloadImage(a.image);if(dl)return {source:'tvdb',sourceRef:a.id,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:lang,selectionStage:'tvdb_original',selectionReason:`TVDB ${lang} logo: first artwork in API response order`};}}
  }
  if(ctx.imdbId){const dl=await metahub.download('logo',ctx.imdbId);if(dl)return {source:'metahub',sourceRef:ctx.imdbId,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'metahub',selectionReason:'MetaHub IMDb logo fallback'};}
  if(ctx.tmdbImages?.logos?.[0]){const img=ctx.tmdbImages.logos[0];const dl=await tmdb.downloadImage(img.file_path,config.tmdbLogoSize);if(dl)return {source:'tmdb',sourceRef:img.file_path,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tmdb_primary',selectionReason:'TMDB first primary/available logo fallback from item image response'};}
  if(tv?.logos?.[0]){const dl=await tvdb.downloadImage(tv.logos[0].image);if(dl)return {source:'tvdb',sourceRef:tv.logos[0].id,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:null,selectionStage:'tvdb_primary',selectionReason:'TVDB first available logo fallback'};}
  return null;
}

const CHAINS={poster:resolvePoster,backdrop:resolveBackdrop,logo:resolveLogo};
async function sweepTpdb() {
  const rows = db.listDueTpdb(50);
  for (const row of rows) {
    const current=db.getArt(row.id,'poster');
    if(current?.is_override||current?.source==='theposterdb') continue;
    const ctx=await buildContext({type:row.type,tmdbId:row.tmdb_id,imdbId:row.imdb_id,tvdbId:row.tvdb_id});
    if(ctx.title) db.updateMediaMeta(row.id,{title:ctx.title,year:ctx.year,originalLanguage:ctx.originalLanguage});
    scheduleTpdb(row,ctx,'periodic-sweep');
  }
}

async function resolve({type,tmdbId,imdbId,tvdbId,artType}){
  const mediaRow=db.findOrCreateMedia({type,tmdbId,imdbId,tvdbId}); db.logRequest(mediaRow.id,artType);
  return singleflight.run(`${mediaRow.id}:${artType}`,async()=>{
    let existing=db.getArt(mediaRow.id,artType);
    if(existing?.source==='theposterdb' && Number(existing.resolver_version||0) < config.tpdbMatcherVersion){
      if(existing.local_path) cache.remove(existing.local_path);
      db.deleteArt(mediaRow.id,artType);
      existing=null;
      if(artType==='poster') db.resetTpdbState(mediaRow.id);
    }
    if(existing?.source==='theposterdb' && existing.source_ref && !cache.exists(existing.local_path)){
      try {
        const dl=await tpdb.downloadPoster(existing.source_ref);
        if(dl) return await persistArt({mediaId:mediaRow.id,artType:'poster',source:'theposterdb',sourceRef:existing.source_ref,sourceUrl:dl.sourceUrl,buffer:dl.buffer,contentType:dl.contentType,language:existing.language,selectionStage:existing.selection_stage||'tpdb',selectionReason:existing.selection_reason||`ThePosterDB cached asset ${existing.source_ref}`});
      } catch(e) { logger.warn(`TPDB cached asset ${existing.source_ref} could not be restored:`,e.message); }
    }
    if(existing&&!isExpired(existing)&&cache.exists(existing.local_path)){
      const ctx=artType==='poster'?await buildContext({type,tmdbId:mediaRow.tmdb_id,imdbId:mediaRow.imdb_id,tvdbId:mediaRow.tvdb_id}):null;
      if(artType==='poster'&&ctx){if(ctx.title)db.updateMediaMeta(mediaRow.id,{title:ctx.title,year:ctx.year,originalLanguage:ctx.originalLanguage});scheduleTpdb(mediaRow,ctx,'fresh-cache');}
      return existing;
    }
    const ctx=await buildContext({type,tmdbId:mediaRow.tmdb_id,imdbId:mediaRow.imdb_id,tvdbId:mediaRow.tvdb_id});
    if(ctx.title)db.updateMediaMeta(mediaRow.id,{title:ctx.title,year:ctx.year,originalLanguage:ctx.originalLanguage});
    const result=await CHAINS[artType](mediaRow,ctx);
    if(!result){ if(existing&&cache.exists(existing.local_path))return existing; return null; }
    // A background TPDb job may have completed while the live fallback chain was running.
    // Never let a late fallback overwrite a newly-found TPDb asset or a manual override.
    const latest=db.getArt(mediaRow.id,artType);
    if(latest?.is_override || latest?.source==='theposterdb') return latest;
    return persistArt({mediaId:mediaRow.id,artType,...result});
  });
}

module.exports={resolve,buildContext,isExpired,sweepTpdb,persistArt};
