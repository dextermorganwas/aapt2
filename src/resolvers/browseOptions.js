'use strict';
const config = require('../config');
const logger = require('../logger');
const tmdb = require('../providers/tmdb');
const tvdb = require('../providers/tvdb');
const tpdb = require('../providers/theposterdb');
const metahub = require('../providers/metahub');
const { buildContext } = require('./resolveArt');

async function listTpdbCandidates(ctx, mediaRow) {
  const title=ctx.title||mediaRow.title; const year=ctx.year||mediaRow.year;
  const searchResult=await tpdb.findPostersPageIds({title,year,mediaType:ctx.type,tmdbId:ctx.tmdbId||mediaRow.tmdb_id,imdbId:ctx.imdbId||mediaRow.imdb_id,tvdbId:ctx.tvdbId||mediaRow.tvdb_id});
  const out=[];
  for(const page of searchResult.pages.slice(0, Math.max(config.tpdbMaxCandidates,12))){
    try {
      const sp=await tpdb.getSetPosters(page.id);
      const relevant=tpdb.relevantPosters(sp.posters,ctx.type);
      const metas=await Promise.all(relevant.map(p=>tpdb.getPosterMeta(p.assetId).catch(()=>null)));
      for(let i=0;i<relevant.length;i++){
        const p=relevant[i], m=metas[i];
        out.push({source:'theposterdb',id:p.assetId,setId:page.id,imageUrl:tpdb.assetImageUrl(p.assetId),language:m?.language||null,variation:m?.variation||null,label:[m?.language,m?.variation,ctx.type==='series'?'Show Cover':'Movie',`page ${page.id}`].filter(Boolean).join(' / ')});
      }
    } catch(e){ logger.debug(`TPDB browse page ${page.id} failed:`,e.message); }
  }
  return out;
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
