'use strict';
const config = require('../config');
const logger = require('../logger');
const tmdb = require('../providers/tmdb');
const tvdb = require('../providers/tvdb');
const tpdb = require('../providers/theposterdb');
const metahub = require('../providers/metahub');
const { buildContext } = require('./resolveArt');

async function listTpdbCandidates(ctx, mediaRow) {
  const title=ctx.title||mediaRow.title; if(!title)return [];
  const searchResult=await tpdb.findPostersPageIds({title,year:ctx.year||mediaRow.year,mediaType:ctx.type,tmdbId:ctx.tmdbId||mediaRow.tmdb_id,imdbId:ctx.imdbId||mediaRow.imdb_id,tvdbId:ctx.tvdbId||mediaRow.tvdb_id});
  const pageIds=[...new Set(searchResult.pages.map(p=>p.id))].slice(0,3);
  const out=[];
  for(const pageId of pageIds){
    const setIds=await tpdb.getCandidateSets(pageId,Math.max(config.tpdbMaxCandidates,12));
    const sets=await Promise.all(setIds.map(async setId=>{
      try { const sp=await tpdb.getSetPosters(setId); return {setId,posters:tpdb.relevantPosters(sp.posters,ctx.type)}; }
      catch(e){ logger.debug(`TPDB browse set ${setId} failed:`,e.message); return {setId,posters:[]}; }
    }));
    for(const s of sets){
      const metas=await Promise.all(s.posters.map(p=>tpdb.getPosterMeta(p.assetId).catch(()=>null)));
      s.posters.forEach((p,i)=>{
        const m=metas[i]; out.push({source:'theposterdb',id:p.assetId,setId:s.setId,imageUrl:tpdb.assetImageUrl(p.assetId),language:m?.language||null,variation:m?.variation||null,label:[m?.language,m?.variation,ctx.type==='series'?'Show Cover':'Movie',`set ${s.setId}`].filter(Boolean).join(' / ')});
      });
    }
  }
  const seen=new Set(); return out.filter(o=>{const k=o.id;if(seen.has(k))return false;seen.add(k);return true;});
}

async function browse(mediaRow){
  const ctx=await buildContext({type:mediaRow.type,tmdbId:mediaRow.tmdb_id,imdbId:mediaRow.imdb_id,tvdbId:mediaRow.tvdb_id});
  const [tvdbData,tpdbList]=await Promise.all([
    tvdb.getArtworks({type:ctx.type,tvdbId:ctx.tvdbId,imdbId:ctx.imdbId,tmdbId:ctx.tmdbId}).catch(()=>null),
    listTpdbCandidates(ctx,mediaRow).catch(e=>{logger.debug('TPDB browse failed:',e.message);return [];})
  ]);
  const posters=[...tpdbList],backdrops=[],logos=[];
  if(ctx.tmdbImages){
    for(const x of ctx.tmdbImages.posters||[]) posters.push({source:'tmdb',id:x.file_path,imageUrl:tmdb.fullImageUrl(x.file_path,config.tmdbPosterSize),language:x.iso_639_1,label:x.iso_639_1||'textless'});
    for(const x of ctx.tmdbImages.backdrops||[]) backdrops.push({source:'tmdb',id:x.file_path,imageUrl:tmdb.fullImageUrl(x.file_path,config.tmdbBackdropSize),language:x.iso_639_1,label:x.iso_639_1||'textless'});
    for(const x of ctx.tmdbImages.logos||[]) logos.push({source:'tmdb',id:x.file_path,imageUrl:tmdb.fullImageUrl(x.file_path,config.tmdbLogoSize),language:x.iso_639_1,label:x.iso_639_1||'textless'});
  }
  if(tvdbData){
    for(const a of tvdbData.posters) posters.push({source:'tvdb',id:a.id,imageUrl:a.image,language:a.language,label:a.language||'textless'});
    for(const a of tvdbData.backgrounds) backdrops.push({source:'tvdb',id:a.id,imageUrl:a.image,language:a.language,includesText:a.includesText,label:a.includesText===false?'textless':a.language||'background'});
    for(const a of tvdbData.logos) logos.push({source:'tvdb',id:a.id,imageUrl:a.image,language:a.language,label:a.language||'textless'});
  }
  if(ctx.imdbId){
    posters.push({source:'metahub',id:ctx.imdbId,imageUrl:metahub.urlFor('poster',ctx.imdbId),label:'MetaHub'});
    backdrops.push({source:'metahub',id:ctx.imdbId,imageUrl:metahub.urlFor('backdrop',ctx.imdbId),label:'MetaHub background'});
    logos.push({source:'metahub',id:ctx.imdbId,imageUrl:metahub.urlFor('logo',ctx.imdbId),label:'MetaHub'});
  }
  return {poster:posters,backdrop:backdrops,logo:logos,context:{title:ctx.title,year:ctx.year,originalLanguage:ctx.originalLanguage}};
}
module.exports={browse,listTpdbCandidates};
