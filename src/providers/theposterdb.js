'use strict';
const cheerio = require('cheerio');
const config = require('../config');
const logger = require('../logger');
const { fetchText, fetchBuffer } = require('../lib/httpClient');

const BASE = 'https://theposterdb.com';
function assetImageUrl(assetId) { return `${BASE}/api/assets/${assetId}`; }
function normalizeTitle(t) { return String(t||'').toLowerCase().replace(/&amp;/g,'&').replace(/[^a-z0-9]+/g,' ').trim(); }
function abs(v) { if (!v) return ''; if (v.startsWith('//')) return `https:${v}`; if (v.startsWith('/')) return BASE+v; return v; }

async function get(path, { background = false } = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  return fetchText(url, { timeoutMs: config.tpdbTimeoutMs, priority: background ? 'background' : 'live' });
}

function parseSearchTargets(html) {
  const $ = cheerio.load(html || ''); const out=[]; const seen=new Set();
  $('a[href*="/posters/"]').each((_,el)=>{
    const href=$(el).attr('href')||''; const m=href.match(/\/posters\/(\d+)/); if(!m) return;
    const id=m[1], text=$(el).text().replace(/\s+/g,' ').trim(); if(!text||seen.has(id)) return;
    seen.add(id); const ym=text.match(/\((\d{4})\)/); out.push({id,text,year:ym?ym[1]:null});
  });
  return out;
}
function exactTarget(candidates, title, year) {
  const want=normalizeTitle(title);
  const exactYear=candidates.find(c=>normalizeTitle(c.text.replace(/\s*\(\d{4}\).*$/,''))===want && (!year || c.year===String(year)));
  if (exactYear) return exactYear;
  const exact=candidates.find(c=>normalizeTitle(c.text.replace(/\s*\(\d{4}\).*$/,''))===want);
  if (exact) return exact;
  return candidates.find(c=>normalizeTitle(c.text).includes(want)) || null;
}

async function search(term, mediaType, background=false) {
  const section=mediaType==='series'?'shows':'movies';
  const out=[]; const seen=new Set(); let url=`/search?${new URLSearchParams({term,section})}`; let pagesFetched=0;
  while(url && pagesFetched < config.tpdbMaxSearchPages){
    const html=await get(url,{background});
    for(const c of parseSearchTargets(html)) if(!seen.has(c.id)){seen.add(c.id);out.push(c);}
    pagesFetched++;
    const $=cheerio.load(html||'');
    let next=$('a[rel="next"]').attr('href') || $('a[rel~="next"]').attr('href') || '';
    if(!next){
      const raw=(html||'').match(/<a[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*next[^"']*["'][^>]*>/i);
      next=raw?.[1]||'';
    }
    url=next ? abs(next) : '';
  }
  return {targets:out,pagesFetched};
}

async function findPostersPageIds({title,year,mediaType,tmdbId,imdbId,tvdbId}, opts={}) {
  const seen=new Set(), pages=[]; let hadError=false;
  // Search the title first. The exact title/year candidate is generally the fastest
  // path and avoids waiting on three sequential identifier searches.
  try {
    const r=await search(title,mediaType,!!opts.background);
    const exact=r.targets.filter(c=>normalizeTitle(c.text.replace(/\s*\(\d{4}\).*$/,''))===normalizeTitle(title));
    exact.sort((a,b)=>(String(a.year)===String(year)?0:1)-(String(b.year)===String(year)?0:1));
    for(const c of [...exact,...r.targets]){
      if(pages.length>=Math.max(config.tpdbMaxCandidates,10)) break;
      if(!seen.has(c.id)){seen.add(c.id);pages.push({id:c.id,via:'title',searchTerm:title,year:c.year});}
    }
  } catch(e){ hadError=true; logger.debug('TPDB title search failed:',e.message); }

  const terms=[...new Set([tmdbId,imdbId,tvdbId].filter(Boolean).map(String))];
  const results=await Promise.allSettled(terms.map(term=>search(term,mediaType,!!opts.background)));
  results.forEach((res,i)=>{
    if(res.status==='rejected'){hadError=true;logger.debug(`TPDB identifier search ${terms[i]} failed:`,res.reason?.message||res.reason);return;}
    for(const c of res.value.targets.slice(0,config.tpdbMaxCandidates)) if(!seen.has(c.id)){seen.add(c.id);pages.push({id:c.id,via:'identifier',searchTerm:terms[i],year:c.year});}
  });
  return {pages,hadError};
}
async function findPostersPageIds({title,year,mediaType,tmdbId,imdbId,tvdbId}, opts={}) {
  const seen=new Set(), pages=[]; let hadError=false;
  const terms=[...new Set([tmdbId, imdbId, tvdbId].filter(Boolean).map(String))];
  for (const term of terms) {
    try {
      const r=await search(term,mediaType,!!opts.background);
      for (const c of r.targets.slice(0,3)) {
        if(!seen.has(c.id)){seen.add(c.id);pages.push({id:c.id,via:'identifier',searchTerm:term});}
      }
    } catch(e) { hadError=true; logger.debug(`TPDB identifier search ${term} failed:`,e.message); }
  }
  try {
    const r=await search(title,mediaType,!!opts.background);
    const best=exactTarget(r.targets,title,year);
    if(best && !seen.has(best.id)) { seen.add(best.id); pages.push({id:best.id,via:'title',searchTerm:title}); }
    // Do not treat loose partial title matches as verified identity. Other title results are
    // retained only as limited candidates and must pass set-level identity checks later.
    for(const c of r.targets.slice(0,5)) {
      if(!seen.has(c.id)){seen.add(c.id);pages.push({id:c.id,via:'title',searchTerm:title});}
    }
  } catch(e) { hadError=true; logger.debug('TPDB title search failed:',e.message); }
  return {pages,hadError};
}
async function findPostersPageId(args, opts={}) { const r=await findPostersPageIds(args,opts); return r.pages[0]?.id || null; }

async function getCandidateSets(postersPageId, maxCandidates, opts={}) {
  if (!postersPageId) return [];
  const html=await get(`/posters/${postersPageId}`, opts); if(!html) return [];
  const $=cheerio.load(html); const out=[]; const seen=new Set();
  $('a[href*="/set/"]').each((_,el)=>{ const m=(($(el).attr('href')||'').match(/\/set\/(\d+)/)); if(!m||seen.has(m[1]))return;seen.add(m[1]);out.push(m[1]); });
  if(!out.length){ const re=/\/set\/(\d+)/g; let m; while((m=re.exec(html))&&out.length<maxCandidates){ if(!seen.has(m[1])){seen.add(m[1]);out.push(m[1]);}} }
  return out.slice(0,maxCandidates);
}

function parseShowCaption(caption){
  const m=String(caption||'').match(/-\s*(?:Season\s+(\d+)|Specials)\s*$/i); if(!m)return 'Cover'; return m[1]?Number(m[1]):0;
}
function parseExternalIds(html){
  const out={}; const text=String(html||'');
  for(const m of text.matchAll(/(?:themoviedb\.org\/(?:movie|tv)|tmdb)\/(\d+)/gi)) out.tmdbId=m[1];
  for(const m of text.matchAll(/(?:imdb\.com\/title\/|imdb)\/?(tt\d+)/gi)) out.imdbId=m[1];
  for(const m of text.matchAll(/(?:thetvdb\.com\/(?:series|movies)|tvdb)\/?(\d+)/gi)) out.tvdbId=m[1];
  return out;
}
async function verifySetIdentity(setId, lookup, opts={}) {
  const html=await get(`/set/${setId}`,opts); if(!html)return {ok:false,html:null};
  const ids=parseExternalIds(html); const titleText=cheerio.load(html)('p#set-title').text().replace(/\s+/g,' ').trim();
  const idMatch=(lookup.tmdbId&&ids.tmdbId===String(lookup.tmdbId))||(lookup.imdbId&&ids.imdbId===String(lookup.imdbId))||(lookup.tvdbId&&ids.tvdbId===String(lookup.tvdbId));
  const titleOk=!lookup.title || normalizeTitle(titleText).includes(normalizeTitle(lookup.title));
  return {ok: idMatch || titleOk, html, ids, titleText};
}

async function parsePosterListingHtml(html){
  const $=cheerio.load(html||''); const posters=[];
  $('div.overlay[data-poster-id]').each((_,el)=>{
    const id=$(el).attr('data-poster-id'); if(!id)return;
    const card=$(el).closest('div.col-6.col-lg-2.p-1').length?$(el).closest('div.col-6.col-lg-2.p-1'):$(el).parent().parent();
    const label=(card.find('a.text-white[data-toggle="tooltip"]').attr('title')||card.find('a.text-white').attr('title')||'').trim();
    const caption=(card.find('p.p-0.mb-1.text-break').first().text()||'').replace(/\s+/g,' ').trim();
    posters.push({assetId:id,mediaTypeLabel:label,caption});
  });
  return {html,posters,setTitle:$('p#set-title').text().replace(/\s+/g,' ').trim(),externalIds:parseExternalIds(html)};
}
async function getSetPosters(setId, opts={}) {
  const pageHtml=await get(`/posters/${setId}`,opts); if(pageHtml){
    const parsed=await parsePosterListingHtml(pageHtml);
    if(parsed.posters.length) return parsed;
  }
  // Some older/alternate TPDb pages expose the grid under /set/{id}; retain it only as fallback.
  const setHtml=await get(`/set/${setId}`,opts); if(!setHtml)return {html:null,posters:[]};
  return parsePosterListingHtml(setHtml);
}
async function getPosterMeta(assetId, opts={}) {
  const html=await get(`/poster/${assetId}`,opts); if(!html)return null;
  const text=cheerio.load(html).text().replace(/\s+/g,' ').trim();
  const m=text.match(/Language:\s*([^|]+?)\s*(?:\||$).*?Type:\s*([^|]+?)\s*(?:\||$).*?Variation:\s*([^|]+?)(?:\||$)/i);
  if(!m)return null;
  return {language:m[1].trim(),type:m[2].trim(),variation:m[3].trim()};
}

function relevantPosters(posters, mediaType){
  return posters.filter(p=>{
    if(mediaType==='series') return /^show$/i.test(p.mediaTypeLabel) && parseShowCaption(p.caption)==='Cover';
    return /^movie$/i.test(p.mediaTypeLabel);
  });
}
async function findEnglishOriginalPoster(args){
  const {title,year,mediaType,background=false}=args;
  const searchResult=await findPostersPageIds(args,{background});
  const pages=searchResult.pages; let inspected=0; let failures=0;
  for(const page of pages){
    try {
      const sp=await getSetPosters(page.id,{background}); inspected++;
      const titleNorm=normalizeTitle(title);
      const pageTitleNorm=normalizeTitle((sp.setTitle||'').replace(/\s*\(\d{4}\).*$/,''));
      const yearMatch=String(sp.setTitle||'').match(/\((\d{4})\)/);
      const titleOk=!title || pageTitleNorm===titleNorm || pageTitleNorm.includes(titleNorm);
      const yearOk=!year || !yearMatch || yearMatch[1]===String(year);
      const idOk=(args.tmdbId && sp.externalIds?.tmdbId===String(args.tmdbId)) || (args.imdbId && sp.externalIds?.imdbId===String(args.imdbId)) || (args.tvdbId && sp.externalIds?.tvdbId===String(args.tvdbId));
      if(page.via==='identifier' ? !(idOk || titleOk) : !(titleOk && yearOk)) continue;

      const relevant=relevantPosters(sp.posters,mediaType);
      for(let i=0;i<relevant.length;i+=config.tpdbMaxPosterMetaInParallel){
        const batch=relevant.slice(i,i+config.tpdbMaxPosterMetaInParallel);
        const metas=await Promise.all(batch.map(p=>getPosterMeta(p.assetId,{background}).catch(e=>{failures++;return null;})));
        for(let j=0;j<batch.length;j++){
          const p=batch[j], meta=metas[j];
          if(meta && /^english$/i.test(meta.language) && /^original$/i.test(meta.variation)) return {postersPageId:page.id,result:{assetId:p.assetId,imageUrl:assetImageUrl(p.assetId),...meta,setId:page.id},status:'found'};
        }
      }
    } catch(e){ failures++; logger.debug(`TPDB poster page ${page.id} failed:`,e.message); }
  }
  const status=(failures>0 && inspected===0) || (failures>0 && inspected===pages.length && pages.length>0 ? 'error' : 'not_found');
  return {postersPageId:pages[0]?.id||null,result:null,status:searchResult.hadError && !pages.length?'error':status};
}
async function downloadPoster(assetId,{background=false}={}){
  const url=assetImageUrl(assetId); const result=await fetchBuffer(url,{timeoutMs:config.tpdbTimeoutMs*3,priority:background?'background':'live'});
  return result?{...result,sourceUrl:url}:null;
}
module.exports={findEnglishOriginalPoster,downloadPoster,assetImageUrl,findPostersPageId,findPostersPageIds,getCandidateSets,getSetPosters,getPosterMeta,parseShowCaption,verifySetIdentity,relevantPosters,parseSearchTargets,exactTarget};
