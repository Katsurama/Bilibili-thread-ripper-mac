"use strict";
// The "auto" CDN mode: mainland and overseas nodes are candidates together, and the speed
// measurements pick among them. Loaded the same way as shared.test.cjs.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=path.join(__dirname,"../shared");
function load(){
  const context=vm.createContext({URL,AbortController,DOMException,Response,ReadableStream,Headers,Uint8Array,Promise,setTimeout,clearTimeout,performance,console});
  context.globalThis=context;
  for(const file of ["range-core.js","cdn-resolver.js"])vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
  return {core:context.__BILI_RANGE_CORE__,cdn:context.__BILI_CDN_RESOLVER_FACTORY__};
}
const mediaUrl=host=>`https://${host}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=x`;
const hostsOf=urls=>new Set(urls.map(url=>new URL(url).hostname));

test("auto is accepted as a mode; unknown values still fall back to mainland",()=>{
  const {core}=load();
  assert.equal(core.normalizeSettings({mode:"auto"}).mode,"auto");
  assert.equal(core.normalizeSettings({mode:"nonsense"}).mode,"mainland");
  assert.equal(core.normalizeSettings({}).mode,"mainland");
});

test("auto offers nodes from both groups for a mainland address",()=>{
  const {cdn}=load();
  const rep={baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")};
  const hosts=hostsOf(cdn.representationUrls(rep,"auto",[]));
  assert.ok([...cdn.MAINLAND_HOSTS].some(host=>hosts.has(host)),"mainland nodes missing");
  assert.ok([...cdn.OVERSEAS_HOSTS].some(host=>hosts.has(host)),"overseas nodes missing");
});

test("auto offers nodes from both groups for an overseas address",()=>{
  const {cdn}=load();
  const rep={baseUrl:mediaUrl("upos-sz-mirrorcosov.bilivideo.com")};
  const hosts=hostsOf(cdn.representationUrls(rep,"auto",[]));
  assert.ok([...cdn.MAINLAND_HOSTS].some(host=>hosts.has(host)),"mainland nodes missing");
  assert.ok([...cdn.OVERSEAS_HOSTS].some(host=>hosts.has(host)),"overseas nodes missing");
});

test("mainland and overseas modes keep their own groups",()=>{
  const {cdn}=load();
  const rep={baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")};
  const mainland=hostsOf(cdn.representationUrls(rep,"mainland",[]));
  const overseas=hostsOf(cdn.representationUrls(rep,"overseas",[]));
  assert.ok([...mainland].every(host=>cdn.MAINLAND_HOSTS.includes(host)),"mainland mode leaked an overseas node");
  assert.ok([...overseas].every(host=>!cdn.MAINLAND_HOSTS.includes(host)),"overseas mode leaked a mainland node");
});
