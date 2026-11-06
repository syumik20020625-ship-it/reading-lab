/* Reading Lab v1.5.1 — path-scoped app shell cache (never caches learning data). */
const CACHE='reading-lab-shell-v1.5.1';
const ASSETS=['./','./index.html','./styles.css','./app.js','./offline_dict.js','./jszip.min.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png'];
const SCOPE=new URL(self.registration.scope);
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('reading-lab-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==SCOPE.origin||!url.pathname.startsWith(SCOPE.pathname)||url.pathname.includes('/api/'))return;
 const known=ASSETS.some(rel=>new URL(rel,SCOPE).pathname===url.pathname);
 if(!known&&request.mode!=='navigate')return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  try{const response=await fetch(request);if(response.ok&&known)cache.put(request,response.clone()).catch(()=>{});return response;}
  catch{
   const cached=await cache.match(request,{ignoreSearch:true});
   return cached||(request.mode==='navigate'?await cache.match(new URL('index.html',SCOPE).href):undefined)||Response.error();
  }
 })());
});
