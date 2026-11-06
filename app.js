(() => {
'use strict';

const STORAGE_KEY = 'reading_lab_data_v1';
const APP_VERSION = '1.5.1';
const SNAPSHOT_DB = 'reading_lab_backups_v1';
const AUTO_SNAPSHOT_DAY = 'reading_lab_last_auto_snapshot_day';
const SYNC_REVISION_KEY = 'reading_lab_last_sync_revision';
let syncToken = '';
let syncRemoteInfo = null;
let installEvent = null;
let snapshotBusy = false;

// v1.5.1: static hosting/iPhone installation support. Keys and learning data stay in the device.
const STATIC_DEPLOY = document.querySelector('meta[name="reading-lab-deployment"]')?.content==='static';
const isIOSDevice = ()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const isStandaloneApp = ()=>window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
let installBannerHidden = false;
function canShowInstallBanner(){
 if(!isIOSDevice()||isStandaloneApp()||location.protocol==='file:'||installBannerHidden)return false;
 try{return localStorage.getItem('reading_lab_install_banner_hidden')!=='yes';}catch{return true;}
}
function updateInstallBanner(){
 const el=document.getElementById('mobileInstallBanner');if(!el)return;
 if(!canShowInstallBanner()){el.innerHTML='';return;}
 el.innerHTML='<div class="ios-install-banner"><div><strong>iPhoneのホーム画面に追加</strong><p>Safariの共有メニューから追加すると、アプリとして開けます。</p></div><button class="btn sm soft" data-act="install-app">方法を見る</button><button class="btn icon-only ghost" data-act="hide-install-banner" aria-label="案内を閉じる">×</button></div>';
}
function showInstallGuide(){
 closeModal();const bg=document.createElement('div');bg.id='modal';bg.className='modal-bg';
 const fileMode=location.protocol==='file:';
 const hosted=!fileMode&&(location.protocol==='https:'||['localhost','127.0.0.1'].includes(location.hostname));
 const already=isStandaloneApp();
 const isIOS=isIOSDevice();
 const instructions=already?'<p>すでにアプリとして起動しています。</p>':fileMode?'<p>現在はHTMLファイルを直接開いています。この形式はホーム画面にインストールできません。公開用ZIPをGitHub PagesなどのHTTPSサイトへ配置し、SafariからそのURLを開いてください。</p>':isIOS?`<ol class="install-steps"><li><b>Safari</b>でこのWebページを開く（他のアプリの内蔵ブラウザでは開かない）。</li><li>Safariの<b>共有ボタン</b>をタップする。</li><li><b>「ホーム画面に追加」→「追加」</b>をタップする。表示されない場合は共有メニューの下を探してね。</li><li>ホーム画面の<b>Reading Lab</b>アイコンから起動する。</li></ol><p class="small muted">既存のHTML版・Safari・ホーム画面版では学習データの保存領域が異なる場合があるため、移行するときはJSONバックアップを読み込んでください。</p>`:'<p>ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選択してください。</p>';
 bg.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="installTitle"><header class="modal-top"><h2 id="installTitle">${isIOS?'iPhoneでReading Labを使う':'Reading Labをインストール'}</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body install-guide">${instructions}${!hosted?'<div class="callout">PWAにはHTTPSまたはlocalhostが必要です。</div>':''}<div class="callout">端末のブラウザデータを削除すると学習履歴を失う可能性があります。「設定 → バックアップを共有」で定期的に保存してください。</div></div><footer class="modal-actions"><button class="btn primary" data-act="close-modal">閉じる</button></footer></section>`;
 document.body.appendChild(bg);
}
function hideInstallBanner(){
 installBannerHidden=true;try{localStorage.setItem('reading_lab_install_banner_hidden','yes');}catch{}
 updateInstallBanner();
}
function backupPayload(){
 persist();return JSON.stringify({...db,exportVersion:2,appVersion:APP_VERSION,exportedAt:new Date().toISOString()},null,2);
}
function backupFileName(){return `reading-lab-backup-${new Date().toISOString().slice(0,10)}.json`;}
async function shareBackup(){
 const contents=backupPayload(),name=backupFileName();
 try{
  const file=new File([contents],name,{type:'application/json'});
  if(navigator.canShare?.({files:[file]})&&typeof navigator.share==='function'){
   await navigator.share({files:[file],title:'Reading Labの学習バックアップ'});
   notify('共有先への保存操作が完了しました。保存先を確認してください。');return;
  }
 }catch(e){if(e?.name==='AbortError')return;console.warn('共有メニューを開けませんでした',e);}
 downloadJSON(contents,name);
 notify('JSONファイルを保存してください。iPhoneでは「ファイル」アプリのダウンロードを確認してください。');
}
function downloadJSON(contents,name){
 const blob=new Blob([contents],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=name;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(url),60000);
}

// Common words are bundled with the HTML; larger free dictionaries are optional imports.
const OFFLINE_CORE = window.READING_LAB_OFFLINE_CORE || Object.create(null);
let importedDictionary = Object.create(null);
let importedDictionaryCount = 0;
const OFFLINE_DB_NAME = 'reading_lab_offline_ja_dictionary';
let storageProblem = null; // Never silently overwrite damaged or unreadable saved data.
function openOfflineDB(){
 return new Promise((resolve,reject)=>{
  if(!('indexedDB' in window)){reject(Error('このブラウザはローカル辞書保存に対応していません'));return;}
  let req;
  try{req=indexedDB.open(OFFLINE_DB_NAME,1);}catch(e){reject(e);return;}
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('data'))req.result.createObjectStore('data');};
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(req.error||Error('辞書データベースを開けませんでした'));
 });
}
async function getStoredDictionary(){
 const db=await openOfflineDB();
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('data','readonly');const r=tx.objectStore('data').get('ejdict');r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});}
 finally{db.close();}
}
async function storeOfflineDictionary(data){
 const db=await openOfflineDB();
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('data','readwrite');tx.objectStore('data').put({entries:data,count:Object.keys(data).length},'ejdict');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error||Error('辞書を保存できませんでした'));tx.onabort=()=>reject(tx.error||Error('辞書の保存が中止されました'));});}
 finally{db.close();}
}
async function clearStoredDictionary(){
 const db=await openOfflineDB();
 try{return await new Promise((resolve,reject)=>{const tx=db.transaction('data','readwrite');tx.objectStore('data').delete('ejdict');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
 finally{db.close();}
}
async function loadOfflineDictionary(){
 try{
  const saved=await getStoredDictionary();
  if(saved?.entries&&typeof saved.entries==='object'){
   importedDictionary=saved.entries;importedDictionaryCount=saved.count||Object.keys(saved.entries).length;
  }
 }catch(e){console.warn('オフライン辞書の読み込みに失敗',e);}
 updateDictionaryStatus();
 if(currentView==='reader'&&panelSelection)renderInsightPanel();
}
function updateDictionaryStatus(){
 const el=document.getElementById('offlineDictionaryStatus');
 if(el)el.textContent=`内蔵 ${Object.keys(OFFLINE_CORE).length.toLocaleString('ja-JP')}語 + 追加辞書 ${importedDictionaryCount.toLocaleString('ja-JP')}語`; 
}
function normalizedDictKey(word){return String(word||'').toLowerCase().trim().replace(/^[\s'"“”‘’]+|[\s'"“”‘’]+$/g,'').replace(/\s+/g,' ');}
function offlineEntry(text){
 for(const w of dictionaryCandidates(text)){
  if(importedDictionary[w])return {ja:importedDictionary[w],headword:w,source:'EJDict（CC0）'};
  if(OFFLINE_CORE[w])return {ja:OFFLINE_CORE[w],headword:w,source:'Reading Lab 内蔵英和'};
 }
 return null;
}
function parseOfflineDictionary(raw,isJSON){
 const dict=Object.create(null);
 function add(key,ja){
  if(typeof key!=='string'||typeof ja!=='string')return;
  const meaning=ja.trim();if(!meaning)return;
  // EJDict permits comma-separated alternate spellings in a single headword.
  for(const spelling of key.split(',')){
   const clean=normalizedDictKey(spelling);
   if(!clean||clean.length>120||dict[clean])continue;
   dict[clean]=meaning.slice(0,2400);
  }
 }
 if(isJSON){
  let data=JSON.parse(raw);
  if(data&&typeof data==='object'&&!Array.isArray(data))data=data.entries||data.words||data;
  if(Array.isArray(data))for(const item of data){
   if(Array.isArray(item))add(item[0],item[1]);
   else if(item&&typeof item==='object')add(item.word||item.key||item.english,item.meaning||item.mean||item.ja||item.translation||item.value);
  }
  else if(data&&typeof data==='object')for(const [k,v] of Object.entries(data)){
   if(typeof v==='string')add(k,v);
   else if(v&&typeof v==='object')add(k,v.meaning||v.mean||v.ja||v.translation);
  }
 }else{
  for(const line of raw.split(/\r?\n/)){
   if(!line||line.startsWith('#'))continue;
   const index=line.indexOf('\t');
   if(index>0)add(line.slice(0,index),line.slice(index+1));
  }
 }
 return dict;
}
async function importOfflineDictionary(file){
 if(!file)return;
 if(file.size>27*1024*1024){notify('辞書ファイルは27MB以下にしてください');return;}
 notify('辞書を読み込んでいます…');
 try{
  const raw=await file.text();
  const data=parseOfflineDictionary(raw,/\.json$/i.test(file.name)||raw.trimStart().startsWith('{')||raw.trimStart().startsWith('['));
  const count=Object.keys(data).length;
  if(count<20)throw Error('辞書データを認識できませんでした。ZIPを展開したTXT/JSONファイルを選択してください。');
  // Keep current data intact until new import is safely stored.
  await storeOfflineDictionary(data);
  importedDictionary=data;importedDictionaryCount=count;
  updateDictionaryStatus();
  if(currentView==='reader'&&panelSelection)renderInsightPanel();
  notify(`${count.toLocaleString('ja-JP')}語を端末に保存しました。次回からオフラインで検索できます。`);
 }catch(err){notify('辞書の取り込みに失敗：'+(err.message||String(err)));}
}
const ICON_PATHS = {
  book:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5V4.5A2.5 2.5 0 0 1 6.5 2Z"/>',
  home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z"/><path d="M9 21v-7h6v7"/>',
  library:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5V4.5A2.5 2.5 0 0 1 6.5 2Z"/><path d="M9 7h7"/>',
  cards:'<rect width="13" height="15" x="7" y="3" rx="2"/><path d="M4 7H3a1 1 0 0 0-1 1v11a2 2 0 0 0 2 2h11a1 1 0 0 0 1-1v-1"/><path d="M10 9h7M10 13h5"/>',
  chart:'<path d="M3 3v18h18"/><path d="M8 17v-5m5 5V7m5 10v-8"/>',
  settings:'<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-1.81 1.81-.06-.06A1.65 1.65 0 0 0 16.1 18.3a1.65 1.65 0 0 0-1.1 1.5V20h-6v-.2a1.65 1.65 0 0 0-1.1-1.5 1.65 1.65 0 0 0-1.82.33l-.06.06-1.81-1.81.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.5-1.1H3v-3.8h.1A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06 1.81-1.81.06.06A1.65 1.65 0 0 0 7.9 5.7 1.65 1.65 0 0 0 9 4.2V4h6v.2a1.65 1.65 0 0 0 1.1 1.5 1.65 1.65 0 0 0 1.82-.33l.06-.06 1.81 1.81-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.5 1.1h.1v3.8h-.1a1.65 1.65 0 0 0-1.5 1.1Z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', back:'<path d="m15 18-6-6 6-6"/>', next:'<path d="m9 18 6-6-6-6"/>', arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', check:'<path d="m5 12 4 4L19 6"/>', close:'<path d="M18 6 6 18M6 6l12 12"/>',
  bookmark:'<path d="M19 21 12 16l-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"/>', target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>', flame:'<path d="M12 22c4.4 0 7-3 7-7 0-4-3-6-4-9-1 3-2 4-4 5 0-4-1-6-2-8C8 7 5 10 5 15c0 4 2.6 7 7 7Z"/>',
  sound:'<path d="M11 5 6 9H3v6h3l5 4V5ZM15 9a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/>', pause:'<path d="M8 5v14M16 5v14"/>', sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>', moon:'<path d="M20.9 13a9 9 0 0 1-9.9-9.9A9 9 0 1 0 20.9 13Z"/>',
  sparkles:'<path d="m12 3 1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9L12 3ZM19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7L19 17Z"/>',
  translate:'<path d="m5 8 6 6m-7 0 6-6M3 5h12M9 3v2m2 16 5-11 5 11m-8-4h6"/>', upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>', download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/>',
  trash:'<path d="M3 6h18m-2 0-1 15H6L5 6m3-3h8l1 3M10 10v7m4-7v7"/>', info:'<circle cx="12" cy="12" r="10"/><path d="M12 11v5m0-9h.01"/>', eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  filter:'<path d="M4 7h16M7 12h10m-7 5h4"/>', file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8m-8 4h8"/>', help:'<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4h.01"/>',
  star:'<path d="m12 2 3 6.8 7.4.7-5.6 5 1.6 7.3-6.4-3.8-6.4 3.8 1.6-7.3-5.6-5 7.4-.7L12 2Z"/>', fileplus:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M9 15h6m-3-3v6"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  folderOpen:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v3M4 20h14a2 2 0 0 0 2-1l2-7H6l-4 7a1 1 0 0 0 2 1Z"/>',
  marker:'<path d="M9 4h6l6 6-9 9-6-6L9 4Z"/><path d="m5 14-2 5 5-2"/>', layers:'<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5m-18 5 9 5 9-5"/>',
  alert:'<path d="m12 3 10 18H2L12 3Zm0 7v4m0 3h.01"/>', rotate:'<path d="M3 12a9 9 0 0 1 15-6l3 3m0-6v6h-6M21 12a9 9 0 0 1-15 6l-3-3m0 6v-6h6"/>'
};
const ico=(name,size=18)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]||ICON_PATHS.info}</svg>`;
const E=(v)=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const W=(text)=>String(text||'').trim().split(/\s+/).filter(Boolean).length;
const formatTime=(n)=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const niceDate=(v)=>new Date(v).toLocaleDateString('ja-JP',{month:'short',day:'numeric'});
const SAMPLE_MATERIALS=[
  {id:'sample-house',title:'The House Beyond the Hill',category:'小説',level:'B1',createdAt:'2026-10-01',text:`The old house had stood at the edge of the village for more than a century. Although nobody had lived there for decades, the villagers were reluctant to approach it. Some claimed that strange noises could be heard from inside after sunset. Others insisted that the noises were nothing more than the wind moving through broken windows.\n\nOne autumn afternoon, a young woman named Clara decided to investigate. She had recently moved to the village and knew little about its strange traditions. The path to the house was covered with leaves, and the garden had become a forest of weeds. As she approached the front door, she noticed a small brass key lying on the steps.\n\nClara picked up the key and carefully turned the handle. To her surprise, the door opened without making a sound. Inside, the furniture was covered in white sheets, but everything seemed unusually clean. On a wooden table she found a letter addressed to someone with her own name.\n\nShe hesitated for a moment before opening it. The handwriting was old-fashioned, and the paper had turned yellow. The letter contained only one sentence: "I have been waiting for you."`},
  {id:'sample-trees',title:'Why Cities Need More Trees',category:'科学・社会',level:'B2',createdAt:'2026-10-02',text:`Cities around the world are becoming warmer, and trees may be one of the most effective ways to make urban life more comfortable. On a hot afternoon, the temperature beneath a large tree can be noticeably lower than the temperature on a nearby street without shade.\n\nTrees reduce heat in two important ways. First, their leaves prevent sunlight from reaching sidewalks and buildings. Second, trees release water vapor into the air through a process called transpiration. As the water evaporates, it helps cool the surrounding environment.\n\nThe benefits go beyond temperature. Urban trees can absorb some pollutants, provide habitats for birds and insects, and make public spaces more pleasant. Researchers have also found associations between access to green spaces and better mental well-being, although the strength of these relationships depends on many factors.\n\nPlanting trees, however, is not enough by itself. Cities must choose suitable species, provide enough soil and water, and maintain the trees over time. Without careful planning, young trees may struggle to survive. A successful urban forest is therefore not simply a collection of trees but a long-term investment in public health and the environment.`},
  {id:'sample-letter',title:'A Small Decision, A Big Change',category:'エッセイ',level:'A2',createdAt:'2026-10-03',text:`When Daniel was a student, he was afraid of speaking English. He knew many words, but he worried about making mistakes. Whenever a teacher asked a question, he looked down at his notebook.\n\nOne day, his friend invited him to join an English conversation club. Daniel wanted to say no, but he decided to try it for just one afternoon. At first, he spoke very slowly. Sometimes he forgot a word and had to explain his idea in a different way.\n\nThe other members listened patiently. Nobody laughed when Daniel made a mistake. Instead, they asked questions and helped him continue. By the end of the meeting, he was tired but happy.\n\nDaniel returned the following week. After several months, speaking English still felt difficult, but it no longer felt impossible. He realized that progress often begins with a small decision to try.`}
];
const BUILTIN={
 'reluctant':{ja:'気が進まない、ためらっている',pos:'形容詞',usage:'be reluctant to do = ～することに気が進まない。',example:'She was reluctant to answer the question.'},
 'approach':{ja:'近づく、接近する',pos:'動詞・名詞',usage:'approach a place = 場所に近づく',example:'We approached the old house.'},
 'claimed':{ja:'主張した',pos:'動詞（claim の過去形）',usage:'claim that ... = ～だと主張する',example:'He claimed that he had seen a light.'},
 'stood':{ja:'立っていた、建っていた',pos:'動詞（stand の過去形）',usage:'stand at the edge of ... = ～の端に位置する'},
 'century':{ja:'100年間、世紀',pos:'名詞',usage:'for more than a century = 100年以上にわたって'},
 'decades':{ja:'数十年',pos:'名詞（decade の複数形）',usage:'for decades = 数十年間'},
 'investigate':{ja:'調査する、詳しく調べる',pos:'動詞',usage:'investigate a mystery = 謎を調べる'},
 'traditions':{ja:'伝統、慣習',pos:'名詞（複数形）'},
 'brass':{ja:'真鍮（しんちゅう）の',pos:'名詞・形容詞'},
 'hesitated':{ja:'ためらった',pos:'動詞（hesitate の過去形）'},
 'handwriting':{ja:'筆跡、手書き文字',pos:'名詞'},
 'unusually':{ja:'異常なほど、普段と違って',pos:'副詞'},
 'transpiration':{ja:'蒸散',pos:'名詞',usage:'植物が葉から水蒸気を放出する現象'},
 'evaporates':{ja:'蒸発する',pos:'動詞（evaporate の三人称単数現在形）'},
 'pollutants':{ja:'汚染物質',pos:'名詞（複数形）'},
 'habitats':{ja:'生息地',pos:'名詞（複数形）'},
 'associations':{ja:'関連、相関',pos:'名詞（複数形）'},
 'well-being':{ja:'幸福、心身の健康',pos:'名詞'},
 'suitable':{ja:'適切な、ふさわしい',pos:'形容詞'},
 'patiently':{ja:'辛抱強く、根気よく',pos:'副詞'},
 'realized':{ja:'気づいた、理解した',pos:'動詞（realize の過去形）'}
};
const SAMPLE_EXPLANATIONS={
 'The old house had stood at the edge of the village for more than a century.':{translate:'その古い家は、100年以上にわたって村の端に建っていた。',grammar:'【主語】The old house\n【動詞】had stood（過去完了形）\n【場所】at the edge of the village\n【期間】for more than a century\n過去のある時点より前から続いていた状態を、過去完了形で表している。'},
 'Although nobody had lived there for decades, the villagers were reluctant to approach it.':{translate:'何十年も誰もそこに住んでいなかったが、村人たちはその家に近づくことをためらっていた。',grammar:'【譲歩の副詞節】Although nobody had lived there for decades\n【主節】the villagers were reluctant to approach it\nAlthough = ～にもかかわらず。had lived は過去完了形。be reluctant to do は「～することに気が進まない」。'},
 'Some claimed that strange noises could be heard from inside after sunset.':{translate:'日没後には家の中から奇妙な音が聞こえると主張する人もいた。',grammar:'【主語】Some（ある人々）\n【動詞】claimed\n【目的語】that 以下の節\nthat節内の could be heard は「聞こえることがある／聞かれた」という受動態。after sunset は「日没後」。'},
 'Cities around the world are becoming warmer, and trees may be one of the most effective ways to make urban life more comfortable.':{translate:'世界中の都市では気温が上昇しており、樹木は都市生活をより快適にする最も効果的な方法の一つかもしれない。',grammar:'and で2つの節を接続している。are becoming は変化の進行を表す現在進行形。to make ... は ways を修飾する不定詞。'},
 'When Daniel was a student, he was afraid of speaking English.':{translate:'ダニエルは学生だったころ、英語を話すことを恐れていた。',grammar:'When Daniel was a student は時を表す副詞節。be afraid of + 動名詞（speaking）で「～することを恐れる」。'}
};
const SAMPLE_QUIZZES={
 'sample-house':[
  {q:'Why did the villagers avoid the house?',options:['It was too far from the village.','They were uneasy about it and heard strange stories.','The owner had locked every entrance.','A storm had destroyed it.'],answer:1,why:'村人たちは家に近づくことをためらい、奇妙な音についての話があった。'},
  {q:'What did Clara find on the steps?',options:['A letter','An old photograph','A brass key','A broken clock'],answer:2,why:'本文に a small brass key lying on the steps とある。'},
  {q:'What made the letter especially surprising?',options:['It was written in French.','It contained a map.','It was addressed to someone with Clara’s name.','It was completely blank.'],answer:2,why:'彼女と同じ名前の人物に宛てた手紙だった。'}
 ],
 'sample-trees':[
  {q:'Which process helps trees cool the surrounding air?',options:['Photosynthesis','Transpiration','Pollination','Germination'],answer:1,why:'葉から水蒸気を放出する蒸散（transpiration）が周囲を冷やす。'},
  {q:'What is the writer’s main argument?',options:['Planting trees is never useful.','All urban trees grow naturally.','Trees offer benefits, but long-term care is necessary.','Green spaces only benefit birds.'],answer:2,why:'最後の段落で植樹だけでなく、樹種選択・水・土壌・維持管理の重要性を述べている。'}
 ],
 'sample-letter':[
  {q:'Why did Daniel avoid answering questions in class?',options:['He disliked his teacher.','He was afraid of making mistakes.','He had never studied English.','He could not hear the questions.'],answer:1,why:'He worried about making mistakes とある。'},
  {q:'What helped Daniel gain confidence?',options:['Practicing with supportive club members.','Memorizing every word in a dictionary.','Taking an exam every day.','Moving to another country.'],answer:0,why:'クラブの仲間は間違いを笑わず、質問して会話を助けた。'}
 ]
};
function initialState(){return {materials:SAMPLE_MATERIALS.map(m=>({...m})),progress:{},saved:[],srs:{},lookups:[],sessions:[],quizResults:[],customQuizzes:{},userGloss:{},syntaxAnnotations:{},folders:{materials:[],saved:[]},settings:{syntaxEnabled:true,librarySort:'manual',reviewSort:'due',dark:false,fontSize:18,voiceRate:0.9,parallelTranslation:false,statsRange:'30',readerLineHeight:2.05,readerWidth:'standard',readerFont:'serif',focusMode:false},notes:{},highlights:[],createdAt:Date.now()};}
// v1.4: folders are separate for reading materials and saved vocabulary. Existing
// items without a folder remain in the non-destructive 未分類 collection.
function normalizeFolders(raw){
 const result={materials:[],saved:[]};
 for(const kind of ['materials','saved']){
  const list=Array.isArray(raw?.[kind])?raw[kind]:[];
  const used=new Set();
  for(const entry of list.slice(0,500)){
   if(!entry||typeof entry.id!=='string'||typeof entry.name!=='string')continue;
   const id=entry.id.slice(0,80),name=entry.name.trim().slice(0,60);
   if(!id||!name||id==='all'||id==='unfiled'||used.has(id))continue;
   result[kind].push({id,name,createdAt:entry.createdAt||new Date().toISOString(),parentId:typeof entry.parentId==='string'?entry.parentId:null,
    linkedMaterialFolderId:kind==='saved'&&typeof entry.linkedMaterialFolderId==='string'?entry.linkedMaterialFolderId:null});
   used.add(id);
  }
  const byId=new Map(result[kind].map(f=>[f.id,f]));
  for(const f of result[kind]){
   if(!byId.has(f.parentId)||f.parentId===f.id){f.parentId=null;continue;}
   const path=new Set([f.id]);let parent=f.parentId;
   while(parent){if(path.has(parent)){f.parentId=null;break;}path.add(parent);parent=byId.get(parent)?.parentId||null;}
  }
 }
 return result;
}
function normalizeState(obj){
 const defaults=initialState();
 const folders=normalizeFolders(obj.folders);
 const cleanItems=kind=>{
  const ids=new Set(folders[kind].map(f=>f.id));
  return (Array.isArray(obj[kind])?obj[kind]:[]).map(item=>({...item,folderId:ids.has(item.folderId)?item.folderId:null}));
 };
 return {...defaults,...obj,
  materials:cleanItems('materials'),saved:cleanItems('saved'),folders,
  notes:obj.notes&&typeof obj.notes==='object'?obj.notes:{},
  highlights:Array.isArray(obj.highlights)?obj.highlights:[],
  customQuizzes:obj.customQuizzes&&typeof obj.customQuizzes==='object'?obj.customQuizzes:{},
  srs:obj.srs&&typeof obj.srs==='object'&&!Array.isArray(obj.srs)?obj.srs:{},
  userGloss:obj.userGloss&&typeof obj.userGloss==='object'&&!Array.isArray(obj.userGloss)?obj.userGloss:{},
  syntaxAnnotations:obj.syntaxAnnotations&&typeof obj.syntaxAnnotations==='object'&&!Array.isArray(obj.syntaxAnnotations)?obj.syntaxAnnotations:{},
  settings:{...defaults.settings,...(obj.settings||{})}
 };
}
function readStorage(){
 let raw;
 try{raw=localStorage.getItem(STORAGE_KEY);}catch(e){storageProblem={kind:'read',message:e.message};return initialState();}
 if(raw===null)return initialState();
 try{const obj=JSON.parse(raw);checkBackupShape(obj);return normalizeState(obj);}
 catch(e){storageProblem={kind:'corrupt',raw,message:e.message};return initialState();}
}
let db=readStorage();
let currentView='home',currentId=null,readerMode='study',panelSelection=null,panelTab='meaning',selectedRange='',selectedContext='',panelMessage=null,activeLookup=null,activeQuiz=null,quizPending=null,sessionStart=null,sessionSeconds=0,quizLoading=false,examReadFinished=false;
let syntaxAiBusy=false;
let searchLibrary='',categoryLibrary='すべて',toastTimeout=null,readerTick=null,selectionTimer=null;
let reviewFilter='all',reviewSearch='',reviewSession=null;
let folderView={materials:'all',saved:'all'};
let folderCollapsed={materials:new Set(),saved:new Set()};
let globalSearch={materials:true,saved:true};
let bulkSelected={materials:new Set(),saved:new Set()};
let analyticsAiResult='',analyticsAiRange='',analyticsAiLoading=false;
let importedSections=null, pdfScriptPromise=null, importBusy=false;
const $=sel=>document.querySelector(sel);
function renderStorageWarning(){
 const el=$('#storageWarning');if(!el)return;
 if(!storageProblem){el.innerHTML='';return;}
 const damaged=storageProblem.kind==='corrupt',write=storageProblem.kind==='write';
 el.innerHTML=`<div class="storage-alert" role="alert"><strong>${damaged?'以前の学習データを安全に読み込めませんでした':write?'変更を保存できていません':'ブラウザの保存領域にアクセスできません'}</strong><p>${damaged?'元データを保護するため自動上書きを停止中です。初期化前に元ファイルを保存してください。':write?'教材や学習内容は現在の画面にはありますが、ブラウザに書き込めていません。JSONとして書き出してください。':'保存領域へのアクセスがブロックされています。変更はこの画面の終了後に失われる可能性があります。'}</p><div class="button-row">${damaged?'<button class="btn sm" data-act="download-damaged">元データをダウンロード</button><button class="btn sm danger" data-act="reset-damaged">初期化して保存を再開</button>':'<button class="btn sm" data-act="export">現時点の学習データを書き出す</button>'}</div></div>`;
}
function persist(){
 if(storageProblem&&storageProblem.kind!=='write'){renderStorageWarning();return false;}
 try{localStorage.setItem(STORAGE_KEY,JSON.stringify(db));if(storageProblem?.kind==='write')storageProblem=null;renderStorageWarning();queueDailySnapshot();return true;}
 catch(e){storageProblem={kind:'write',message:e.message};renderStorageWarning();notify('保存に失敗しました。バックアップを書き出してください。');return false;}
}
function downloadDamaged(){
 if(storageProblem?.kind!=='corrupt')return;
 const blob=new Blob([storageProblem.raw],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`reading-lab-recovery-${new Date().toISOString().slice(0,10)}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
function resetDamaged(){
 if(storageProblem?.kind!=='corrupt')return;
 if(!confirm('読めなくなった保存データを初期化します。事前に元データをダウンロードしましたか？'))return;
 try{localStorage.removeItem(STORAGE_KEY);storageProblem=null;db=initialState();persist();renderShell();notify('初期化して保存を再開しました');}
 catch(e){storageProblem={kind:'read',message:e.message};renderStorageWarning();notify('初期化できませんでした：'+e.message);}
}
const getM=id=>db.materials.find(m=>m.id===id);
const getP=id=>db.progress[id]||(db.progress[id]={percent:0,seconds:0,lastPosition:0,finished:false,lastOpened:null});
const materialCover=(m)=>m.category.includes('科学')?'green':m.category.includes('エッセイ')?'peach':'';
const materialGlyph=(m)=>m.category.includes('科学')?'✧':m.category.includes('エッセイ')?'✎':'✦';
function notify(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('show'),3300);}
function stopSpeech(){try{speechSynthesis.cancel();}catch{}}
function stopSession(){if(sessionStart&&currentId){if(sessionSeconds>0)db.sessions.unshift({id:'s'+Date.now(),materialId:currentId,seconds:sessionSeconds,mode:readerMode,date:new Date().toISOString()});sessionStart=null;sessionSeconds=0;persist();}stopSpeech();}
function startSession(){sessionStart=Date.now();sessionSeconds=0;}
function ensureTimer(){if(readerTick)return;readerTick=setInterval(()=>{if(document.hidden)return;if(currentView==='reader'&&currentId){getP(currentId).seconds++;sessionSeconds++;if(sessionSeconds%10===0)persist();const t=$('#elapsedTime');if(t)t.textContent=formatTime(sessionSeconds);}else if(currentView==='quiz'&&activeQuiz&&!activeQuiz.showResult){activeQuiz.elapsed++;const e=$('#quizElapsed');if(e)e.textContent=formatTime(activeQuiz.elapsed);const l=$('#quizRemaining');if(l)l.textContent=formatTime(Math.max(0,activeQuiz.timeLimitSeconds-activeQuiz.elapsed));if(activeQuiz.timeLimitSeconds>0&&activeQuiz.elapsed>=activeQuiz.timeLimitSeconds)submitQuiz(true);}},1000);}
function navBtn(view,label,iconName){return `<button class="nav-btn ${currentView===view?'active':''}" data-act="nav" data-view="${view}">${ico(iconName)}<span>${label}</span></button>`;}
function mobileNavBtn(view,label,iconName){return `<button class="${currentView===view?'active':''}" data-act="nav" data-view="${view}">${ico(iconName)}<span>${label}</span></button>`;}
function shell(){return `<div class="app-shell"><aside class="sidebar"><div class="brand" data-act="nav" data-view="home"><div class="brand-icon">${ico('book',22)}</div><div><div class="brand-name">Reading Lab</div><div class="brand-sub">READ · LEARN · GROW</div></div></div><div class="nav-label">WORKSPACE</div><nav class="nav">${navBtn('home','ホーム','home')}${navBtn('library','教材ライブラリ','library')}${navBtn('review','単語・復習','cards')}${navBtn('stats','学習レポート','chart')}</nav><div class="nav-spacer"></div><nav class="nav">${navBtn('settings','設定','settings')}</nav><div class="sidebar-foot"><strong>${ico('sparkles',14)} 今日のひとこと</strong>Every page is a small step forward.<br>自分のペースで、少しずつ。</div></aside><main class="main-area"><div id="storageWarning"></div><div class="mobile-head"><div class="brand" data-act="nav" data-view="home"><div class="brand-icon">${ico('book',19)}</div><div><div class="brand-name">Reading Lab</div><div class="brand-sub">ENGLISH READING</div></div></div><button class="btn icon-only ghost" data-act="nav" data-view="settings" aria-label="設定">${ico('settings')}</button></div><div id="mobileInstallBanner"></div><div id="page"></div></main></div><nav class="bottom-nav">${mobileNavBtn('home','ホーム','home')}${mobileNavBtn('library','教材','library')}${mobileNavBtn('review','復習','cards')}${mobileNavBtn('stats','記録','chart')}${mobileNavBtn('settings','設定','settings')}</nav>`;}
function renderShell(){document.body.classList.toggle('dark',!!db.settings.dark);$('#app').innerHTML=shell();renderPage();renderStorageWarning();updateInstallBanner();}
function updateNav(){document.querySelectorAll('[data-act="nav"]').forEach(b=>{if(b.tagName==='BUTTON')b.classList.toggle('active',b.dataset.view===currentView);});}
function go(view,id=null){if(currentView==='reader')stopSession();currentView=view;if(id)currentId=id;panelSelection=null;panelMessage=null;selectedRange='';if(view==='reader'&&!getM(currentId)){currentView='library';currentId=null;}if(view==='reader'){examReadFinished=false;getP(currentId).lastOpened=new Date().toISOString();startSession();}renderPage();updateNav();window.scrollTo({top:0,behavior:'instant'});}
function header(title,description,extra=''){return `<div class="page-head"><div><div class="eyebrow">READING LAB / ${E(title)}</div><h1>${E(title)}</h1><p>${description}</p></div>${extra}</div>`;}
function statCard(iconName,val,unit,cap){return `<div class="card stat-card"><div class="stat-icon">${ico(iconName)}</div><div><span class="stat-val">${E(val)}</span><span class="stat-unit">${E(unit)}</span></div><div class="stat-caption">${E(cap)}</div></div>`;}
// v1.5: hierarchical folders, full-collection searching, bulk actions and source-linked vocabulary.
const FOLDER_TYPES=['materials','saved'];
const validKind=kind=>FOLDER_TYPES.includes(kind);
const folderList=kind=>validKind(kind)?db.folders[kind]:[];
const folderOf=item=>item?.folderId||'unfiled';
const folderById=(kind,id)=>folderList(kind).find(f=>f.id===id)||null;
function folderAncestors(kind,id){
 const out=[],seen=new Set();let cur=folderById(kind,id);
 while(cur&&!seen.has(cur.id)){seen.add(cur.id);out.unshift(cur);cur=folderById(kind,cur.parentId);}
 return out;
}
const folderPath=(kind,id)=>id==='all'?'すべて':id==='unfiled'||!id?'未分類':folderAncestors(kind,id).map(x=>x.name).join(' / ')||'未分類';
const folderDepth=(kind,id)=>folderAncestors(kind,id).length;
function folderDescendant(kind,id,ancestor){return !!id&&folderAncestors(kind,id).some(f=>f.id===ancestor);}
function folderName(kind,id){if(!id||id==='unfiled')return '未分類';if(id==='all')return 'すべて';return folderById(kind,id)?.name||'未分類';}
function collectionInView(kind){const id=folderView[kind];return db[kind].filter(item=>id==='all'||folderOf(item)===id);}
function folderChoices(kind,selected='unfiled',excluded=null){
 const walk=(parent='',depth=0)=>folderList(kind).filter(f=>(f.parentId||'')===parent&&f.id!==excluded&&!folderDescendant(kind,f.id,excluded)).map(f=>`<option value="${E(f.id)}" ${selected===f.id?'selected':''}>${E('　'.repeat(depth)+f.name)}</option>${walk(f.id,depth+1)}`).join('');
 return `<option value="unfiled" ${selected==='unfiled'?'selected':''}>未分類</option>${walk()}`;
}
function sortChoice(kind){
 const opts=[['manual','手動で並べる'],['title',kind==='materials'?'タイトル順':'英単語順'],['newest','登録が新しい順'],['oldest','登録が古い順'],...(kind==='materials'?[['progress','読書進捗が高い順']]:[['due','復習待ちを優先'],['weak','苦手な順']])];
 const key=kind==='materials'?'librarySort':'reviewSort';
 const current=db.settings[key]||'manual';
 return `<label class="collection-sort">並べ替え <select class="select-input" id="${kind==='materials'?'librarySort':'reviewSort'}" aria-label="並べ替え">${opts.map(([id,title])=>`<option value="${id}" ${current===id?'selected':''}>${title}</option>`).join('')}</select></label>`;
}
function sortCollection(items,kind){
 const key=kind==='materials'?'librarySort':'reviewSort';const sort=db.settings[key]||'manual',all=items.slice();
 const alpha=(a,b)=>String(a.title||a.text||'').localeCompare(String(b.title||b.text||''),'en',{sensitivity:'base'}),date=x=>Date.parse(x.createdAt||'')||0;
 if(sort==='title')all.sort(alpha);if(sort==='newest')all.sort((a,b)=>date(b)-date(a));if(sort==='oldest')all.sort((a,b)=>date(a)-date(b));
 if(sort==='progress'&&kind==='materials')all.sort((a,b)=>(getP(b.id)?.percent||0)-(getP(a.id)?.percent||0));
 if(sort==='due'&&kind==='saved')all.sort((a,b)=>Number(reviewDue(b))-Number(reviewDue(a))||reviewWeakness(b)-reviewWeakness(a));
 if(sort==='weak'&&kind==='saved')all.sort((a,b)=>reviewWeakness(b)-reviewWeakness(a));return all;
}
function manualMoveAllowed(kind){
 const key=kind==='materials'?'librarySort':'reviewSort';return folderView[kind]!=='all'&&db.settings[key]==='manual'&&
  (kind==='materials'?(!searchLibrary&&categoryLibrary==='すべて'):(!reviewSearch&&reviewFilter==='all'));
}
function collectionOrderActions(kind,item){
 if(!manualMoveAllowed(kind))return '';const list=collectionInView(kind),idx=list.findIndex(x=>x.id===item.id);
 return `<div class="reorder-arrows"><button class="btn sm icon-only" data-act="item-up" data-kind="${kind}" data-id="${E(item.id)}" aria-label="上へ移動" ${idx<=0?'disabled':''}>↑</button><button class="btn sm icon-only" data-act="item-down" data-kind="${kind}" data-id="${E(item.id)}" aria-label="下へ移動" ${idx<0||idx===list.length-1?'disabled':''}>↓</button></div>`;
}
function collectionMoveControl(kind,item){
 return `<div class="item-organize"><label>保存先 <select class="select-input collection-move" data-kind="${kind}" data-id="${E(item.id)}" aria-label="保存先を変更">${folderChoices(kind,folderOf(item))}</select></label>${collectionOrderActions(kind,item)}</div>`;
}
const getSearchQuery=kind=>(kind==='materials'?searchLibrary:reviewSearch).trim().toLocaleLowerCase();
function scopedForSearch(kind){return getSearchQuery(kind)&&globalSearch[kind]?db[kind]:collectionInView(kind);}
function getMaterialSearchText(m){return `${m.title} ${m.text} ${m.category||''} ${m.level||''} ${folderPath('materials',folderOf(m))} ${JSON.stringify(db.notes[m.id]||{})}`.toLocaleLowerCase();}
function getReviewSearchText(item){return `${item.text} ${item.note||''} ${item.context||''} ${folderPath('saved',folderOf(item))} ${getM(item.materialId)?.title||''}`.toLocaleLowerCase();}
function materialExcerpt(m){
 const query=getSearchQuery('materials');if(!query)return '';
 const pos=m.text.toLocaleLowerCase().indexOf(query);if(pos<0)return '';
 return `<p class="search-excerpt">本文：…${E(m.text.slice(Math.max(0,pos-35),Math.min(m.text.length,pos+query.length+65)).replace(/\s+/g,' '))}…</p>`;
}
function folderNavigation(kind){
 const items=db[kind],selected=folderView[kind];
 const top=[{id:'all',name:'すべて',count:items.length},{id:'unfiled',name:'未分類',count:items.filter(x=>folderOf(x)==='unfiled').length}];
 const row=(f,depth=0,children=false)=>`<div class="folder-row ${selected===f.id?'selected':''}" style="--folder-depth:${depth}">${children?`<button class="folder-expand" data-act="folder-expand" data-kind="${kind}" data-id="${E(f.id)}" aria-label="${folderCollapsed[kind].has(f.id)?'展開':'折りたたむ'}">${folderCollapsed[kind].has(f.id)?'▸':'▾'}</button>`:'<span class="folder-expand-spacer"></span>'}<button class="folder-open" data-act="folder-select" data-kind="${kind}" data-id="${E(f.id)}" aria-current="${selected===f.id?'true':'false'}" title="${E(folderPath(kind,f.id))}">${ico(f.id==='all'?'layers':'folder',15)}<span class="folder-text">${E(f.name)}</span><span class="folder-count">${f.count}</span></button>${f.id!=='all'&&f.id!=='unfiled'?`<span class="folder-actions"><button class="folder-mini" data-act="folder-child" data-kind="${kind}" data-id="${E(f.id)}" title="子フォルダを追加">${ico('plus',13)}</button><button class="folder-mini" data-act="folder-rename" data-kind="${kind}" data-id="${E(f.id)}" title="編集">${ico('edit',13)}</button><button class="folder-mini" data-act="folder-delete" data-kind="${kind}" data-id="${E(f.id)}" title="削除">${ico('trash',13)}</button></span>`:''}</div>`;
 const recurse=(parent='',depth=0)=>folderList(kind).filter(f=>(f.parentId||'')===parent).map(f=>{
  const children=folderList(kind).some(x=>x.parentId===f.id);
  return row({...f,count:items.filter(x=>folderOf(x)===f.id).length},depth,children)+(folderCollapsed[kind].has(f.id)?'':recurse(f.id,depth+1));
 }).join('');
 return `<aside class="folder-pane" aria-label="フォルダ"><div class="folder-heading"><strong>${ico('folder',16)} フォルダ</strong><button class="btn sm soft" data-act="folder-new" data-kind="${kind}">${ico('plus',13)} 新規</button></div><div class="folder-list">${top.map(f=>row(f)).join('')}${recurse()}</div><p class="folder-footnote">「＋」で子フォルダを追加。削除しても教材・単語は残ります。</p></aside>`;
}
function showFolderModal(kind,id=null,parentHint=null){
 if(!validKind(kind))return;const folder=id?folderById(kind,id):null;if(id&&!folder)return;
 let parentId=folder?.parentId||parentHint||(folderView[kind]!=='all'&&folderView[kind]!=='unfiled'?folderView[kind]:'unfiled');
 if(folderDepth(kind,parentId)>=6)parentId='unfiled';
 closeModal();const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';bg.dataset.folderKind=kind;bg.dataset.folderId=id||'';
 bg.innerHTML=`<section class="modal folder-modal" role="dialog" aria-modal="true"><header class="modal-top"><h2>${folder?'フォルダを編集':'新しいフォルダ'}</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body"><div class="field"><label for="folderTitleInput">フォルダ名</label><input id="folderTitleInput" value="${E(folder?.name||'')}" maxlength="60" placeholder="例：英語小説"></div><div class="field"><label for="folderParentInput">親フォルダ</label><select id="folderParentInput">${folderChoices(kind,parentId,id)}</select></div><div class="callout">フォルダは最大6階層まで。フォルダを削除しても中の教材・単語は消えません。</div></div><footer class="modal-actions"><button class="btn" data-act="close-modal">キャンセル</button><button class="btn primary" data-act="folder-save">${ico('check',15)} 保存</button></footer></section>`;
 document.body.appendChild(bg);$('#folderTitleInput')?.focus();
}
function saveFolder(){
 const el=$('#modal'),kind=el?.dataset.folderKind,id=el?.dataset.folderId||null;if(!validKind(kind))return;
 const name=$('#folderTitleInput')?.value.trim(),rawParent=$('#folderParentInput')?.value||'unfiled',parentId=rawParent==='unfiled'?null:rawParent;
 if(!name){notify('フォルダ名を入力してください');return;}
 if(parentId&&(!folderById(kind,parentId)||parentId===id||folderDescendant(kind,parentId,id))){notify('この親フォルダは選択できません');return;}
 const subtreeHeight=(fid)=>1+Math.max(0,...folderList(kind).filter(f=>f.parentId===fid).map(f=>subtreeHeight(f.id)));
 if(folderDepth(kind,parentId)+(id?subtreeHeight(id):1)>6){notify('フォルダは最大6階層です');return;}
 if(folderList(kind).some(f=>f.id!==id&&f.parentId===parentId&&f.name.toLocaleLowerCase()===name.toLocaleLowerCase())){notify('同じ階層に同名のフォルダがあります');return;}
 if(id){const f=folderById(kind,id);if(!f)return;f.name=name;f.parentId=parentId;if(kind==='saved'&&f.linkedMaterialFolderId)f.linkedMaterialFolderId=null;}
 else{const created='folder-'+Date.now()+'-'+Math.random().toString(36).slice(2,9);db.folders[kind].push({id:created,name,parentId,createdAt:new Date().toISOString()});folderView[kind]=created;}
 if(kind==='materials')syncAutoVocabularyFolders();
 persist();closeModal();renderPage();notify(id?'フォルダを更新しました':'フォルダを作成しました');
}
function removeFolder(kind,id){
 if(!validKind(kind)||!folderById(kind,id))return;const f=folderById(kind,id),count=db[kind].filter(x=>x.folderId===id).length;
 const children=folderList(kind).filter(x=>x.parentId===id).length;
 if(!confirm(`「${folderPath(kind,id)}」を削除しますか？\n中の項目 ${count}件は親フォルダ（なければ未分類）へ移動します。子フォルダ ${children}件も一段上へ移動します。`))return;
 for(const item of db[kind])if(item.folderId===id){item.folderId=f.parentId||null;if(kind==='saved'&&item.autoFolder)item.autoFolder=false;}
 for(const child of folderList(kind))if(child.parentId===id)child.parentId=f.parentId||null;
 db.folders[kind]=folderList(kind).filter(x=>x.id!==id);
 if(folderView[kind]===id)folderView[kind]=f.parentId||'unfiled';folderCollapsed[kind].delete(id);
 if(kind==='materials')syncAutoVocabularyFolders();
 persist();renderPage();notify('フォルダを削除し、中身は保持しました');
}
function ensureLinkedVocabularyFolder(materialFolderId){
 const source=folderById('materials',materialFolderId);if(!source)return null;
 const ancestor=source.parentId?ensureLinkedVocabularyFolder(source.parentId):null;
 let target=folderList('saved').find(f=>f.linkedMaterialFolderId===source.id);
 if(!target){
  if(folderList('saved').length>=500)return null;
  target={id:'vocab-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),name:source.name,parentId:ancestor,createdAt:new Date().toISOString(),linkedMaterialFolderId:source.id};
  db.folders.saved.push(target);
 }else{target.name=source.name;target.parentId=ancestor;}
 return target.id;
}
function autoFolderForMaterial(materialId){
 const material=getM(materialId);return material&&folderOf(material)!=='unfiled'?ensureLinkedVocabularyFolder(material.folderId):null;
}
function syncAutoVocabularyFolders(){
 // Automatically classified cards follow their original material; manual moves opt out.
 for(const card of db.saved){if(!card.autoFolder)continue;card.folderId=autoFolderForMaterial(card.materialId);}
 for(const f of [...folderList('saved')])if(f.linkedMaterialFolderId&&folderById('materials',f.linkedMaterialFolderId))ensureLinkedVocabularyFolder(f.linkedMaterialFolderId);
 for(const f of folderList('saved'))if(f.linkedMaterialFolderId&&!folderById('materials',f.linkedMaterialFolderId))f.linkedMaterialFolderId=null;
}
function autoClassifyExistingCards(){
 const cards=db.saved.filter(x=>!x.folderId&&getM(x.materialId));if(!cards.length){notify('自動分類できる未分類カードはありません');return;}
 if(!confirm(`未分類の ${cards.length}件を、元の教材のフォルダに合わせて分類しますか？\n教材が未分類の場合はそのまま残します。`))return;
 let moved=0;for(const item of cards){const target=autoFolderForMaterial(item.materialId);if(target){item.folderId=target;item.autoFolder=true;moved++;}}
 persist();renderPage();notify(`${moved}件のカードを教材別フォルダへ分類しました`);
}
function moveItemToFolder(kind,id,target){
 if(!validKind(kind))return;if(target!=='unfiled'&&!folderById(kind,target)){notify('移動先が見つかりません');return;}
 const collection=db[kind],item=collection.find(x=>x.id===id);if(!item)return;
 if(kind==='saved')item.autoFolder=false;
 if(folderOf(item)!==target){collection.splice(collection.indexOf(item),1);item.folderId=target==='unfiled'?null:target;collection.push(item);}
 if(kind==='materials')syncAutoVocabularyFolders();persist();renderPage();notify(`「${folderPath(kind,target)}」に移動しました`);
}
function reorderItem(kind,id,delta){
 if(!validKind(kind)||!manualMoveAllowed(kind)){notify('フォルダ内で「手動で並べる」を選択してください');return;}
 const scoped=collectionInView(kind),pos=scoped.findIndex(x=>x.id===id);if(pos<0||pos+delta<0||pos+delta>=scoped.length)return;
 const collection=db[kind],a=collection.indexOf(scoped[pos]),b=collection.indexOf(scoped[pos+delta]);[collection[a],collection[b]]=[collection[b],collection[a]];
 persist();renderPage();
}
function bulkToggle(kind,id,checked){
 if(!validKind(kind)||!db[kind].some(x=>x.id===id))return;
 if(checked)bulkSelected[kind].add(id);else bulkSelected[kind].delete(id);
 renderBulkBar(kind);
}
function visibleCollection(kind){return kind==='materials'?selectLibraryItems():selectReviewItems();}
function bulkSelectVisible(kind){
 const ids=visibleCollection(kind).map(x=>x.id);if(!ids.length)return;
 const all=ids.every(id=>bulkSelected[kind].has(id));for(const id of ids)all?bulkSelected[kind].delete(id):bulkSelected[kind].add(id);
 renderPage();
}
function bulkMove(kind){
 const selected=bulkSelected[kind],target=$(`#bulkTarget-${kind}`)?.value||'unfiled';
 if(!selected.size)return;if(target!=='unfiled'&&!folderById(kind,target)){notify('移動先が見つかりません');return;}
 let n=0;for(const item of [...db[kind]])if(selected.has(item.id)){db[kind].splice(db[kind].indexOf(item),1);item.folderId=target==='unfiled'?null:target;
  if(kind==='saved')item.autoFolder=false;db[kind].push(item);n++;}
 if(kind==='materials')syncAutoVocabularyFolders();selected.clear();persist();renderPage();notify(`${n}件を「${folderPath(kind,target)}」へ移動しました`);
}
function deleteMaterialRecord(id){
 const index=db.materials.findIndex(m=>m.id===id);if(index<0)return false;
 db.materials.splice(index,1);delete db.progress[id];delete db.notes[id];delete db.syntaxAnnotations[id];delete db.customQuizzes[id];
 db.highlights=db.highlights.filter(h=>h.materialId!==id);
 for(const item of db.saved.filter(x=>x.materialId===id))delete db.srs[item.id];
 db.saved=db.saved.filter(x=>x.materialId!==id);db.lookups=db.lookups.filter(x=>x.materialId!==id);
 db.sessions=db.sessions.filter(x=>x.materialId!==id);db.quizResults=db.quizResults.filter(x=>x.materialId!==id);
 if(currentId===id){currentId=null;activeQuiz=null;panelSelection=null;}return true;
}
function bulkDelete(kind){
 const ids=[...bulkSelected[kind]].filter(id=>db[kind].some(x=>x.id===id));if(!ids.length)return;
 const extra=kind==='materials'?db.saved.filter(x=>ids.includes(x.materialId)).length:0;
 if(!confirm(`${kind==='materials'?'教材':'単語'} ${ids.length}件を削除しますか？${extra?`\n教材に紐づいた単語 ${extra}件や学習履歴も削除されます。`:''}\nこの操作は取り消せません。必要なら先にバックアップしてください。`))return;
 if(kind==='materials')for(const id of ids)deleteMaterialRecord(id);
 else{const idSet=new Set(ids);db.saved=db.saved.filter(x=>!idSet.has(x.id));for(const id of ids)delete db.srs[id];}
 bulkSelected[kind].clear();for(const k of FOLDER_TYPES)for(const id of [...bulkSelected[k]])if(!db[k].some(x=>x.id===id))bulkSelected[k].delete(id);
 persist();renderPage();notify(`${ids.length}件を削除しました`);
}
function bulkBar(kind){
 const count=bulkSelected[kind].size,visible=visibleCollection(kind),allVisible=visible.length>0&&visible.every(x=>bulkSelected[kind].has(x.id));
 return `<div class="bulk-bar" id="bulkBar-${kind}"><button class="btn sm" data-act="bulk-all" data-kind="${kind}" ${visible.length?'':'disabled'}>${allVisible?'表示中の選択を解除':'表示中を全選択'} (${visible.length})</button><span class="bulk-count">${count}件選択</span><label>移動先 <select class="select-input" id="bulkTarget-${kind}" ${count?'':'disabled'}>${folderChoices(kind,folderView[kind]==='all'?'unfiled':folderView[kind])}</select></label><button class="btn sm soft" data-act="bulk-move" data-kind="${kind}" ${count?'':'disabled'}>まとめて移動</button><button class="btn sm danger" data-act="bulk-delete" data-kind="${kind}" ${count?'':'disabled'}>まとめて削除</button><button class="btn sm" data-act="bulk-clear" data-kind="${kind}" ${count?'':'disabled'}>選択解除</button></div>`;
}
function renderBulkBar(kind){
 const bar=$(`#bulkBar-${kind}`),oldTarget=$(`#bulkTarget-${kind}`)?.value;
 if(bar){bar.outerHTML=bulkBar(kind);const next=$(`#bulkTarget-${kind}`);if(next&&oldTarget&&[...next.options].some(o=>o.value===oldTarget))next.value=oldTarget;}
 document.querySelectorAll(`[data-bulk-kind="${kind}"]`).forEach(el=>{el.checked=bulkSelected[kind].has(el.dataset.id);});
}
function searchAllControl(kind){return `<label class="search-all-toggle"><input type="checkbox" id="searchAll-${kind}" ${globalSearch[kind]?'checked':''}> 全フォルダから検索</label>`;}
function materialCard(m,small=false){
 const p=getP(m.id),wc=W(m.text);
 return `<article class="material-card" ${currentView==='library'&&!small&&manualMoveAllowed('materials')?'draggable="true"':''} data-item-kind="materials" data-item-id="${E(m.id)}"><div class="material-cover ${materialCover(m)}">${materialGlyph(m)}</div><div class="material-info">${currentView==='library'&&!small?`<label class="bulk-item-check"><input type="checkbox" data-bulk-kind="materials" data-id="${E(m.id)}" ${bulkSelected.materials.has(m.id)?'checked':''}> 選択</label>`:''}<h3 class="material-title" title="${E(m.title)}">${E(m.title)}</h3><div class="meta">${E(m.category)} · ${E(m.level)} · ${wc.toLocaleString()}語 ${currentView==='library'?`· ${E(folderPath('materials',folderOf(m)))}`:''}</div><div class="button-row" style="margin-top:9px"><span class="tag ${p.finished?'green':p.percent>0?'blue':''}">${p.finished?'読了':p.percent>0?`進捗 ${p.percent}%`:'未学習'}</span></div>${currentView==='library'&&!small?materialExcerpt(m):''}${!small?`<div class="material-actions"><button class="btn sm soft" data-act="open" data-id="${E(m.id)}">${ico('book',14)} ${p.percent>0?'続きを読む':'読む'}</button><button class="btn sm" data-act="edit-material" data-id="${E(m.id)}" aria-label="${E(m.title)}を編集">${ico('edit',14)} 編集</button><button class="btn sm danger" data-act="delete-material" data-id="${E(m.id)}" aria-label="${E(m.title)}を削除">${ico('trash',14)} 削除</button></div>${currentView==='library'?collectionMoveControl('materials',m):''}`:''}</div>${small?`<button class="btn sm" data-act="open" data-id="${E(m.id)}">${ico('arrow',13)}</button>`:''}</article>`;
}
function renderHome(){const started=db.materials.filter(m=>getP(m.id).percent>0).sort((a,b)=>(getP(b.id).lastOpened||'').localeCompare(getP(a.id).lastOpened||''));const featured=started[0]||db.materials[0];const totalSeconds=Object.values(db.progress).reduce((s,p)=>s+(p.seconds||0),0);const readCount=db.materials.filter(m=>getP(m.id).finished).length;const days=new Set(db.sessions.map(x=>x.date.slice(0,10))).size;return `<div class="page-wrap">${header('ホーム','今日も少しずつ、英語に触れていこう。','<button class="btn primary" data-act="add">'+ico('plus')+' 教材を追加</button>')}<div class="layout-grid"><section><div class="card welcome"><div class="eyebrow">YOUR READING SPACE</div><h2>Every story makes you stronger.</h2><p>読みたい英文を自由に登録。知らない単語はその場で調べて、理解した内容を少しずつ積み重ねよう。</p><button class="btn" data-act="open" data-id="${E(featured?.id||'')}">${ico('book')} ${started.length?'前回の続きから読む':'最初の教材を読む'} ${ico('arrow',15)}</button></div><div class="stats-row">${statCard('clock',Math.round(totalSeconds/60),'分','累計読書時間')}${statCard('book',readCount,'本','読了した教材')}${statCard('flame',days,'日','学習した日数')}</div><div class="section-heading"><h2>教材を選ぶ</h2><button class="muted-link" data-act="nav" data-view="library">すべて見る →</button></div>${db.materials.slice(0,3).map(m=>materialCard(m,true)).join('')||'<div class="card empty">教材がありません。</div>'}</section><section><div class="card right-card"><div class="card-title">${ico('target',17)} 学習の進め方</div><div class="task"><div class="task-number">01</div><div><h4>英文を読む</h4><p>気になる単語をクリックして調べる</p></div></div><div class="task"><div class="task-number">02</div><div><h4>文の意味を確かめる</h4><p>ドラッグして和訳・構文を確認する</p></div></div><div class="task"><div class="task-number">03</div><div><h4>演習モードでテスト</h4><p>WPM・正答率を測定して復習する</p></div></div></div><div class="card right-card" style="margin-top:16px"><div class="card-title">${ico('cards',17)} 今日の復習</div><div style="font-size:33px;font-weight:800">${dueItems().length}<span class="stat-unit">枚</span></div><p class="small muted" style="line-height:1.9">保存した${db.saved.length}件から、今日復習するカードを自動で選びます。</p><button class="btn soft" data-act="nav" data-view="review">復習する ${ico('arrow',14)}</button></div><div class="card right-card" style="margin-top:16px"><div class="card-title">${ico('info',17)} プライバシー</div><div class="small muted" style="line-height:1.9">教材・学習履歴はこのブラウザ内に保存されます。別端末との同期は、設定画面から任意の同期サーバーを使って手動で行えます。</div></div></section></div></div>`;}
function selectLibraryItems(){
 const query=getSearchQuery('materials');return sortCollection(scopedForSearch('materials').filter(m=>(categoryLibrary==='すべて'||m.category===categoryLibrary)&&(!query||getMaterialSearchText(m).includes(query))),'materials');
}
function renderLibrary(){
 const cats=['すべて',...new Set(db.materials.map(m=>m.category))];
 return `<div class="page-wrap">${header('教材ライブラリ','全文検索・親子フォルダ・一括管理で教材を整理できます。','<button class="btn primary" data-act="add">'+ico('plus')+' 教材を追加</button>')}<div class="organizer">${folderNavigation('materials')}<section class="organizer-main"><div class="organizer-main-head"><div><h2>${E(folderPath('materials',folderView.materials))}</h2><p class="small muted">${collectionInView('materials').length}件の教材</p></div>${sortChoice('materials')}</div><div class="library-tools"><input class="search-input" id="librarySearch" type="search" placeholder="タイトル・本文・メモから全文検索" value="${E(searchLibrary)}" aria-label="教材を検索"><select class="select-input" id="libraryCategory" aria-label="教材カテゴリ">${cats.map(c=>`<option value="${E(c)}" ${categoryLibrary===c?'selected':''}>${E(c)}</option>`).join('')}</select>${searchAllControl('materials')}</div>${bulkBar('materials')}<div id="libraryCards"></div><p class="sort-hint small muted">フォルダ内の手動並び替えは↑↓・ドラッグで操作。検索中は全フォルダを横断できます。</p></section></div></div>`;
}
function renderLibraryCards(){
 const items=selectLibraryItems(),el=$('#libraryCards');if(!el)return;
 el.innerHTML=items.length?`<p class="search-result-count">${items.length}件表示</p><div class="library-grid">${items.map(m=>materialCard(m)).join('')}</div>`:`<div class="card empty"><div class="empty-icon">${ico('folder',32)}</div><p>条件に合う教材がありません。</p><button class="btn sm primary" data-act="add">教材を追加</button></div>`;
 renderBulkBar('materials');
}
// Review schedule: local calendar days; legacy saved items without a record are due today.
const localDate=(date=new Date())=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const daysLater=(days,now=new Date())=>{const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()+days,12);return localDate(d);};
const reviewRecord=(item)=>db.srs?.[item.id]||null;
const reviewDue=(item,day=localDate())=>!reviewRecord(item)?.dueAt||reviewRecord(item).dueAt<=day;
const dueItems=()=>db.saved.filter(item=>reviewDue(item));
const reviewMeaning=item=>item.note?.trim()||getWordEntry(item.text)?.ja||'（意味未登録。編集から日本語訳を入力してください）';
const reviewKind=kind=>kind==='word'?'単語':kind==='phrase'?'熟語・フレーズ':'英文';
const reviewNextLabel=item=>!reviewRecord(item)?.dueAt?'未学習':reviewDue(item)?'復習待ち':`次回 ${reviewRecord(item).dueAt}`;
const reviewWeakness=item=>{const s=reviewRecord(item);return s?.attempts?Number(s.lapses||0)*10+(1-(s.successes||0)/s.attempts)*5+Math.max(0,4-(s.ease||2.5)):0;};
const reviewTotalStats=(cards=db.saved)=>{const records=cards.map(reviewRecord).filter(Boolean);const attempts=records.reduce((n,s)=>n+(s.attempts||0),0);const successes=records.reduce((n,s)=>n+(s.successes||0),0);return {due:cards.filter(reviewDue).length,learned:records.filter(s=>(s.repetitions||0)>=2).length,attempts,successes,accuracy:attempts?Math.round(100*successes/attempts):null};};
function nextReviewSchedule(old,grade,now=new Date()){
 const r=old&&typeof old==='object'?old:{};
 let ease=Math.max(1.3,Math.min(3,Number(r.ease)||2.5));
 let interval=Math.max(0,Math.min(3650,Number(r.intervalDays)||0));
 let repetitions=Math.max(0,Number(r.repetitions)||0);
 let lapses=Math.max(0,Number(r.lapses)||0);
 if(grade==='again'){ease=Math.max(1.3,ease-0.2);interval=0;repetitions=0;lapses++;}
 else if(grade==='hard'){ease=Math.max(1.3,ease-0.15);interval=Math.max(1,Math.ceil(interval*1.2));repetitions=Math.max(1,repetitions);}
 else if(grade==='good'){interval=repetitions===0?1:repetitions===1?3:Math.max(interval+1,Math.round(interval*ease));repetitions++;}
 else if(grade==='easy'){ease=Math.min(3,ease+0.15);interval=repetitions===0?4:Math.max(5,Math.ceil(Math.max(1,interval)*ease*1.3));repetitions++;}
 else throw Error('Unknown review grade');
 interval=Math.min(interval,3650);
 const nowISO=now.toISOString();
 const h=Array.isArray(r.history)?r.history.slice(-79):[];
 h.push({date:nowISO,grade,intervalDays:interval});
 return {dueAt:daysLater(interval,now),intervalDays:interval,ease:Number(ease.toFixed(2)),repetitions,lapses,attempts:(r.attempts||0)+1,successes:(r.successes||0)+(grade==='good'||grade==='easy'?1:0),lastGrade:grade,lastReviewedAt:nowISO,history:h};
}
function startReview(scope='due'){
 const scoped=collectionInView('saved');const all=scope==='all'?scoped:scoped.filter(reviewDue);
 if(!all.length){notify('復習するカードがありません');return;}
 reviewSession={scope,queue:all.slice(0,60).map(item=>item.id),index:0,flipped:false,results:[],complete:false};
 currentView='review';renderPage();window.scrollTo(0,0);
}
function revealReview(){if(!reviewSession||reviewSession.complete)return;reviewSession.flipped=true;renderPage();}
function gradeReview(grade){
 if(!reviewSession||reviewSession.complete||!reviewSession.flipped)return;
 const id=reviewSession.queue[reviewSession.index];const item=db.saved.find(x=>x.id===id);
 if(!item){reviewSession.index++;renderPage();return;}
 db.srs ||= {};db.srs[id]=nextReviewSchedule(db.srs[id],grade);
 reviewSession.results.push({id,grade,text:item.text});reviewSession.index++;
 reviewSession.flipped=false;reviewSession.complete=reviewSession.index>=reviewSession.queue.length;
 persist();renderPage();
}
function showReviewEditor(id){
 const item=db.saved.find(x=>x.id===id);if(!item)return;
 closeModal();const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';bg.dataset.reviewId=id;
 bg.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="reviewEditTitle"><header class="modal-top"><h2 id="reviewEditTitle">復習カードを編集</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body"><div class="note-box">${E(item.text)}</div><div class="field"><label for="reviewEditMeaning">日本語の意味・自分のメモ</label><textarea id="reviewEditMeaning" rows="4" maxlength="5000" placeholder="日本語の意味を入力">${E(item.note||'')}</textarea></div><div class="field"><label for="reviewEditContext">元の英文・文脈</label><textarea id="reviewEditContext" rows="3" maxlength="5000">${E(item.context||'')}</textarea></div><div class="callout">内容を編集しても、これまでの復習回数と次回復習日は変わりません。</div></div><footer class="modal-actions"><button class="btn" data-act="close-modal">キャンセル</button><button class="btn primary" data-act="save-review-edit">${ico('check')} 保存</button></footer></section>`;
 document.body.appendChild(bg);$('#reviewEditMeaning')?.focus();
}
function saveReviewEditor(){const id=$('#modal')?.dataset.reviewId,item=db.saved.find(x=>x.id===id);if(!item)return;item.note=$('#reviewEditMeaning')?.value.trim()||'';item.context=$('#reviewEditContext')?.value.trim()||'';persist();closeModal();renderPage();notify('復習カードを更新しました');}
function renderReviewStudy(){
 const sess=reviewSession;if(!sess)return '';
 if(sess.complete){const count=sess.results.length,good=sess.results.filter(x=>['good','easy'].includes(x.grade)).length,again=sess.results.filter(x=>x.grade==='again').length;
  return `<div class="review-study card"><div class="review-complete-icon">${ico('check',32)}</div><div class="eyebrow">REVIEW FINISHED</div><h2>今日の復習が完了しました</h2><p class="muted">${count}枚のカードを学習しました。復習予定は自動で更新されています。</p><div class="review-summary-grid"><div><strong>${count}</strong><span>学習枚数</span></div><div><strong>${good}</strong><span>覚えた・簡単</span></div><div><strong>${again}</strong><span>もう一度</span></div></div>${again?'<p class="small muted">「もう一度」を選んだカードは、本日の復習対象に残ります。</p>':''}<div class="button-row review-center"><button class="btn primary" data-act="start-review" data-scope="due">残りの復習を始める</button><button class="btn" data-act="exit-review">一覧に戻る</button></div></div>`;
 }
 const item=db.saved.find(x=>x.id===sess.queue[sess.index]);if(!item){sess.index++;if(sess.index>=sess.queue.length)sess.complete=true;return renderReviewStudy();}
 const ratio=Math.round(sess.index/sess.queue.length*100),rec=reviewRecord(item);
 return `<div class="review-study card"><div class="review-topline"><span class="tag blue">${E(reviewKind(item.kind))}</span><span class="small muted">${sess.index+1} / ${sess.queue.length} 枚</span></div><div class="progress-track"><div class="progress-bar" style="width:${ratio}%"></div></div><div class="review-flashcard"><p class="overline">QUESTION · 英語から意味を思い出そう</p><h2>${E(item.text)}</h2>${item.context?`<div class="review-context">${E(item.context)}</div>`:''}${sess.flipped?`<div class="review-answer" role="status"><p class="overline">ANSWER · 意味</p><p>${E(reviewMeaning(item))}</p></div>`:`<div class="review-answer-hidden">答えを思い出してから「答えを表示」を押してください</div>`}</div>${sess.flipped?`<div class="review-grade-area"><p class="small muted">どのくらい覚えていましたか？</p><div class="review-grade-grid"><button class="grade-btn again" data-act="review-grade" data-grade="again"><strong>もう一度</strong><span>今日中</span></button><button class="grade-btn hard" data-act="review-grade" data-grade="hard"><strong>難しい</strong><span>短めに復習</span></button><button class="grade-btn good" data-act="review-grade" data-grade="good"><strong>覚えた</strong><span>間隔を伸ばす</span></button><button class="grade-btn easy" data-act="review-grade" data-grade="easy"><strong>簡単</strong><span>長めに復習</span></button></div></div>`:`<button class="btn primary review-reveal" data-act="review-reveal">${ico('eye',17)} 答えを表示</button>`}<div class="button-row review-center"><button class="btn sm" data-act="review-edit" data-id="${E(item.id)}">${ico('edit',13)} 意味を編集</button><button class="btn sm" data-act="review-speak" data-id="${E(item.id)}">${ico('sound',13)} 発音</button><button class="btn sm" data-act="exit-review">終了して一覧へ</button></div>${rec?`<p class="review-last small muted">前回の復習：${rec.lastReviewedAt?niceDate(rec.lastReviewedAt):'未学習'} · ${rec.attempts||0}回</p>`:''}</div>`;
}
function selectReviewItems(){
 let items=scopedForSearch('saved').filter(x=>!getSearchQuery('saved')||getReviewSearchText(x).includes(getSearchQuery('saved')));
 if(reviewFilter==='due')items=items.filter(reviewDue);
 if(reviewFilter==='weak')items=items.filter(x=>(reviewRecord(x)?.lapses||0)>0||(reviewRecord(x)?.attempts>=2&&(reviewRecord(x)?.successes||0)/(reviewRecord(x)?.attempts||1)<0.65));
 return sortCollection(items,'saved');
}
function renderReview(){
 const scoped=collectionInView('saved'),total=scoped.length,summary=reviewTotalStats(scoped),items=selectReviewItems();
 const filterButtons=[['all','すべて'],['due','復習待ち'],['weak','苦手な表現']];
 return `<div class="page-wrap">${header('単語・復習','語彙専用のフォルダで整理し、フォルダごとにフラッシュカードを学習できます。','<div class="button-row"><button class="btn sm soft" data-act="auto-classify">未分類を教材別に分類</button><span class="tag blue">'+db.saved.length+' 件保存</span></div>')}<div class="review-dashboard"><div class="card review-stat"><span>${folderView.saved==='all'?'全体':'選択中のフォルダ'}・今日の復習</span><strong>${summary.due}</strong><small>枚が復習待ち</small></div><div class="card review-stat"><span>定着中のカード</span><strong>${summary.learned}</strong><small>2回以上成功</small></div><div class="card review-stat"><span>復習の成功率</span><strong>${summary.accuracy===null?'—':summary.accuracy+'%'}</strong><small>${summary.attempts}回の回答</small></div></div>${reviewSession?renderReviewStudy():`<div class="organizer">${folderNavigation('saved')}<section class="organizer-main"><div class="organizer-main-head"><div><h2>${E(folderName('saved',folderView.saved))}</h2><p class="small muted">${total}件の単語・表現</p></div>${sortChoice('saved')}</div><div class="review-intro card"><div><h2>このフォルダを復習する</h2><p>英語を見て意味を思い出し、4段階で自己評価。次の復習日を自動調整します。</p></div><div class="button-row"><button class="btn primary" data-act="start-review" data-scope="due" ${!summary.due?'disabled':''}>${ico('cards',17)} 今日の復習（${summary.due}枚）</button><button class="btn" data-act="start-review" data-scope="all" ${!total?'disabled':''}>この範囲の全カード</button></div></div><div class="section-heading review-list-heading"><h2>保存した単語・表現</h2><span id="reviewResultCount" class="small muted">${items.length}件表示</span></div><div class="review-tools"><div class="review-tabs">${filterButtons.map(([k,label])=>`<button class="btn sm ${reviewFilter===k?'soft':''}" data-act="review-filter" data-filter="${k}" aria-pressed="${reviewFilter===k}">${label}</button>`).join('')}</div><input class="search-input" id="reviewSearch" type="search" placeholder="単語・日本語訳・元の教材から検索" value="${E(reviewSearch)}" aria-label="復習リストを検索">${searchAllControl('saved')}</div>${bulkBar('saved')}<div id="reviewListCards" class="review-grid">${renderReviewCards(items)}</div><p class="sort-hint small muted">「手動で並べる」を選びフォルダ内で↑↓を操作。PCではドラッグでも移動できます。</p></section></div>`}</div>`;
}
function renderReviewCards(items){
 return items.length?items.map(item=>{
  const r=reviewRecord(item),attempts=r?.attempts||0,accuracy=attempts?Math.round(100*(r.successes||0)/attempts):null;
  return `<article class="card review-card" ${manualMoveAllowed('saved')?'draggable="true"':''} data-item-kind="saved" data-item-id="${E(item.id)}"><label class="bulk-item-check"><input type="checkbox" data-bulk-kind="saved" data-id="${E(item.id)}" ${bulkSelected.saved.has(item.id)?'checked':''}> 選択</label><div class="review-card-top"><span class="tag ${reviewDue(item)?'blue':''}">${E(reviewKind(item.kind))}</span><span class="review-due ${reviewDue(item)?'is-due':''}">${E(reviewNextLabel(item))}</span></div><h3>${E(item.text)}</h3><p class="review-meaning">${E(reviewMeaning(item))}</p>${item.context?`<p class="review-context-inline">${E(item.context)}</p>`:''}<div class="review-card-detail">${attempts?`復習 ${attempts}回 · 成功 ${accuracy}% · つまずき ${r.lapses||0}回`:'まだ復習していません'} · ${E(folderPath('saved',folderOf(item)))}</div><p class="source-link">教材：${E(getM(item.materialId)?.title||'元の教材なし')}${item.autoFolder?' · 自動分類':''}</p>${collectionMoveControl('saved',item)}<div class="button-row"><button class="btn sm" data-act="review-edit" data-id="${E(item.id)}">${ico('edit',13)} 意味を編集</button><button class="btn sm" data-act="jump-saved" data-id="${E(item.materialId)}">本文へ</button><button class="btn sm danger" data-act="remove-saved" data-id="${E(item.id)}" aria-label="削除">${ico('trash',13)}</button></div></article>`;
 }).join(''):`<div class="card empty" style="grid-column:1/-1"><div class="empty-icon">${ico('folder',30)}</div><h3>${db.saved.length?'この条件に合うカードはありません':'まだ保存した表現はありません'}</h3><p>${db.saved.length?'フォルダ・検索条件を変更してみてください。':'リーディング画面で単語や英文を選択して保存してみよう。'}</p><button class="btn primary" data-act="nav" data-view="library">教材を読む</button></div>`;
}
// v0.4.0: analytics are computed only from locally recorded study data.
// All charts are native SVG and work offline with no third-party packages.
const ANALYTICS_RANGES=[['7','7日'],['30','30日'],['90','90日'],['all','全期間']];
const statRange=()=>['7','30','90','all'].includes(String(db.settings.statsRange))?String(db.settings.statsRange):'30';
function analyticDate(value){
 if(typeof value!=='string')return null;
 const d=new Date(value);
 return Number.isFinite(d.getTime())?d:null;
}
function inStatsRange(dateStr,range=statRange()){
 const d=analyticDate(dateStr);if(!d)return false;
 if(range==='all')return d.getTime()<=Date.now()+86400000;
 const days=Number(range),cutoff=new Date();cutoff.setHours(0,0,0,0);cutoff.setDate(cutoff.getDate()-days+1);
 return d>=cutoff&&d.getTime()<=Date.now()+86400000;
}
function analyticsDay(iso){const d=analyticDate(iso);return d?localDate(d):null;}
function chartLine(points,label,{unit='',maxY=null,stroke='#6372c8'}={}){
 const valid=points.filter(p=>Number.isFinite(p.value)&&analyticDate(p.date)).sort((a,b)=>new Date(a.date)-new Date(b.date));
 if(!valid.length)return `<div class="analytics-empty">${ico('chart',25)}<span>この期間の${E(label)}はまだありません。</span></div>`;
 const width=680,height=192,l=47,r=17,t=19,b=30,innerW=width-l-r,innerH=height-t-b;
 const max=Math.max(1,maxY||Math.ceil(Math.max(...valid.map(x=>x.value),1)/((unit==='%')?25:25))*25);
 const leftDate=new Date(valid[0].date).getTime(),rightDate=new Date(valid[valid.length-1].date).getTime();
 const x=(date,i)=>valid.length===1?l+innerW/2:rightDate===leftDate?l+innerW*i/(valid.length-1):l+innerW*(new Date(date).getTime()-leftDate)/(rightDate-leftDate);
 const y=v=>t+innerH*(1-Math.min(1,Math.max(0,v/max)));
 const coords=valid.map((p,i)=>[x(p.date,i),y(p.value)]);
 const path=coords.map(([a,b],i)=>`${i?'L':'M'}${a.toFixed(2)} ${b.toFixed(2)}`).join(' ');
 const grid=[0,0.5,1].map(fr=>{const yy=y(max*fr);return `<line class="analytics-gridline" x1="${l}" y1="${yy}" x2="${width-r}" y2="${yy}"/><text class="analytics-axis" x="${l-8}" y="${yy+4}" text-anchor="end">${Math.round(max*fr)}${unit}</text>`;}).join('');
 const dateLabel=d=>{const parsed=analyticDate(d);return parsed?`${parsed.getMonth()+1}/${parsed.getDate()}`:''};
 const labels=`<text class="analytics-axis" x="${l}" y="${height-6}">${E(dateLabel(valid[0].date))}</text><text class="analytics-axis" x="${width-r}" y="${height-6}" text-anchor="end">${E(dateLabel(valid[valid.length-1].date))}</text>`;
 const dots=coords.map(([a,b],i)=>`<circle class="analytics-point" cx="${a.toFixed(2)}" cy="${b.toFixed(2)}" r="${valid.length>48?2.9:4.2}" fill="${stroke}" tabindex="0"><title>${E(niceDate(valid[i].date))}: ${valid[i].value}${E(unit)}</title></circle>`).join('');
 const summary=`${valid.length}件の記録。最初 ${valid[0].value}${unit}、直近 ${valid[valid.length-1].value}${unit}。`;
 return `<div class="analytics-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${E(label)}の推移。${E(summary)}" xmlns="http://www.w3.org/2000/svg">${grid}<path d="${path}" stroke="${stroke}" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}</svg></div><div class="analytics-chart-foot"><span>${E(summary)}</span>${valid.length===1?'<span>点が1件のため傾向は判断できません。</span>':''}</div>`;
}
function statsHistory(){
 const range=statRange();
 const tests=db.quizResults.filter(t=>t&&Number.isFinite(t.total)&&t.total>0&&Number.isFinite(t.score)&&inStatsRange(t.date,range)).sort((a,b)=>new Date(a.date)-new Date(b.date));
 const sessions=db.sessions.filter(s=>s&&Number.isFinite(s.seconds)&&s.seconds>0&&inStatsRange(s.date,range));
 const reviews=[];
 for(const item of db.saved){const r=reviewRecord(item);if(!r||!Array.isArray(r.history))continue;
  for(const h of r.history){if(!h||!inStatsRange(h.date,range))continue;reviews.push({...h,itemId:item.id});}}
 reviews.sort((a,b)=>new Date(a.date)-new Date(b.date));
 return {tests,sessions,reviews};
}
function readingDailyPoints(sessions,range=statRange()){
 if(!sessions.length)return [];
 const dates=new Map();
 for(const s of sessions){const day=analyticsDay(s.date);if(!day)continue;dates.set(day,(dates.get(day)||0)+s.seconds/60);}
 const all=[...dates].sort(([a],[b])=>a.localeCompare(b));
 // A 90-day/all-time view uses study days (not invented values for unrecorded days).
 return all.map(([day,minutes])=>({date:day+'T12:00:00',value:Number(minutes.toFixed(1))}));
}
function reviewDailyPoints(reviews){const days=new Map();for(const h of reviews){const day=analyticsDay(h.date);if(!day)continue;const bucket=days.get(day)||{pass:0,total:0};bucket.total++;if(['good','easy'].includes(h.grade))bucket.pass++;days.set(day,bucket);}return [...days].sort(([a],[b])=>a.localeCompare(b)).map(([day,v])=>({date:day+'T12:00:00',value:Math.round(v.pass/v.total*100)}));}
function quizTypeSummary(tests){
 const stats=Object.fromEntries(Object.keys(QUIZ_TYPES).map(k=>[k,{type:k,correct:0,total:0,materialMisses:new Map()}]));
 let usable=0;
 for(const test of tests){if(!Array.isArray(test.questions)||!Array.isArray(test.answers))continue;
  test.questions.forEach((q,i)=>{if(!q||!QUIZ_TYPES[q.type]||!Number.isInteger(q.answer))return;
   const s=stats[q.type];const correct=Number(test.answers[i])===q.answer&&test.answers[i]!==null;
   s.total++;if(correct)s.correct++;else if(test.materialId)s.materialMisses.set(test.materialId,(s.materialMisses.get(test.materialId)||0)+1);usable++;
  });
 }
 return {rows:Object.values(stats).filter(x=>x.total).sort((a,b)=>a.correct/a.total-b.correct/b.total),usable};
}
function analyticsRecommendations(tests,typeStats){
 const suggestions=[];
 const due=dueItems().length;
 if(due>0)suggestions.push({icon:'cards',title:`復習待ちのカード ${due}枚`,why:'復習予定日が今日以前の単語・熟語があります。短時間の復習から始めましょう。',action:'nav',view:'review',button:'カードを復習する'});
 const weakest=typeStats.rows.find(s=>s.total>=3&&s.correct/s.total<0.75);
 if(weakest){
  const entries=[...weakest.materialMisses].filter(([id])=>!!getM(id)).sort((a,b)=>b[1]-a[1]);
  const material=entries.length?getM(entries[0][0]):null;
  suggestions.push({icon:'target',title:`${QUIZ_TYPES[weakest.type]}を重点的に`,why:`この期間の正答率 ${Math.round(weakest.correct/weakest.total*100)}%（${weakest.correct}/${weakest.total}問）。誤答が多かった教材を精読して根拠を確認しましょう。`,action:material?'open':'nav',id:material?.id,view:'library',button:material?'本文を読み直す':'教材を選ぶ'});
 }
 const weak=db.saved.filter(item=>{const r=reviewRecord(item);return r&&r.attempts>=2&&((r.lapses||0)>0||(r.successes||0)/r.attempts<0.65);}).sort((a,b)=>reviewWeakness(b)-reviewWeakness(a));
 if(weak.length)suggestions.push({icon:'bookmark',title:`つまずいた表現を確認（${weak.length}件）`,why:`過去の復習で「もう一度」を選んだ、または成功率が低いカードを確認できます。`,action:'analytics-weak',button:'苦手カードを見る'});
 const ongoing=db.materials.filter(m=>{const p=getP(m.id);return p.percent>0&&!p.finished;}).sort((a,b)=>(getP(b.id).lastOpened||'').localeCompare(getP(a.id).lastOpened||''));
 const first=ongoing[0]||db.materials.find(m=>!getP(m.id).finished)||db.materials[0];
 if(first)suggestions.push({icon:'book',title:`${ongoing.length?'前回の続きを読む':'次の教材を読む'}：${first.title}`,why:`${E(first.category)} · ${E(first.level)}。${ongoing.length?'途中まで読んだ教材を優先しています。':'まだ読了していない教材を選びました。'}`,action:'open',id:first.id,button:'この教材を読む'});
 if(!suggestions.length)suggestions.push({icon:'library',title:'新しい英文を登録する',why:'現在の教材がありません。英文を追加すると、ここに学習履歴に応じた提案が表示されます。',action:'nav',view:'library',button:'ライブラリを開く'});
 return suggestions.slice(0,4);
}
function cefrQuizSummary(tests){
 const groups=new Map();
 for(const test of tests){const m=getM(test.materialId);if(!m||!m.level)continue;
  const level=String(m.level),g=groups.get(level)||{level,count:0,score:0,wpmSum:0,wpmCount:0};
  g.count++;g.score+=test.score/test.total;
  if(Number.isFinite(test.wpm)&&test.wpm>0){g.wpmSum+=test.wpm;g.wpmCount++;}
  groups.set(level,g);
 }
 return [...groups.values()].sort((a,b)=>a.level.localeCompare(b.level));
}
async function generateAnalyticsAI(){
 if(analyticsAiLoading)return;
 const {tests,sessions,reviews}=statsHistory();const t=quizTypeSummary(tests);
 if(!tests.length&&!reviews.length&&!sessions.length){notify('分析できる学習記録がまだありません');return;}
 if(!confirm('現在の分析期間について、教材本文や単語そのものは送らず、集計値だけをAIサーバーに送信します。AI利用にはサーバー側のAPI設定と利用料が必要です。続けますか？'))return;
 const summary={period:statRange(),tests:tests.length,averageScore:tests.length?Math.round(tests.reduce((n,x)=>n+x.score/x.total,0)/tests.length*100):null,
  wpm:tests.filter(x=>Number.isFinite(x.wpm)&&x.wpm>0).map(x=>x.wpm).slice(-15),
  readingMinutes:Math.round(sessions.reduce((n,x)=>n+x.seconds,0)/60),
  reviewAttempts:reviews.length,reviewGoodOrEasy:reviews.filter(x=>['good','easy'].includes(x.grade)).length,
  questionTypes:t.rows.map(x=>({type:QUIZ_TYPES[x.type],correct:x.correct,total:x.total}))};
 analyticsAiLoading=true;analyticsAiResult='';analyticsAiRange=statRange();renderPage();
 try{analyticsAiResult=await aiRequest('analysis',{text:JSON.stringify(summary),context:'数値はアプリ内の学習記録。データが少ない場合は断定しない。'});}catch(e){analyticsAiResult='AI分析を取得できませんでした：'+(e.message||String(e));}
 finally{analyticsAiLoading=false;if(currentView==='stats')renderPage();}
}
function renderStats(){
 const {tests,sessions,reviews}=statsHistory();
 const scores=tests.map(t=>({date:t.date,value:Math.round(t.score/t.total*100)}));
 const speeds=tests.filter(t=>Number.isFinite(t.wpm)&&t.wpm>0).map(t=>({date:t.date,value:Math.round(t.wpm)}));
 const average=scores.length?Math.round(scores.reduce((n,p)=>n+p.value,0)/scores.length):null;
 const avgWpm=speeds.length?Math.round(speeds.reduce((n,p)=>n+p.value,0)/speeds.length):null;
 const minutes=Math.round(sessions.reduce((n,s)=>n+s.seconds,0)/60);
 const correct=reviews.filter(h=>['good','easy'].includes(h.grade)).length;
 const reviewPct=reviews.length?Math.round(correct/reviews.length*100):null;
 const typeStats=quizTypeSummary(tests);
 const recs=analyticsRecommendations(tests,typeStats);
 const levels=cefrQuizSummary(tests);
 const recent=[...tests].reverse().slice(0,12);
 const range=statRange();
 const rangeTitle=range==='all'?'全期間':`直近${range}日`;
 const activeDays=new Set([...sessions.map(s=>analyticsDay(s.date)),...reviews.map(s=>analyticsDay(s.date)),...tests.map(s=>analyticsDay(s.date))].filter(Boolean)).size;
 const reviewPoints=reviewDailyPoints(reviews);
 return `<div class="page-wrap analytics-page">
  ${header('学習レポート','読解・読書速度・復習履歴を比較し、次の学習を選びます。')}
  <div class="analytics-toolbar"><div><b>分析期間</b><p class="small muted">端末に保存された学習履歴を集計</p></div><div class="analytics-periods" role="group" aria-label="分析期間">${ANALYTICS_RANGES.map(([v,label])=>`<button class="btn sm ${v===range?'soft':''}" data-act="stats-range" data-range="${v}" aria-pressed="${v===range}">${label}</button>`).join('')}</div></div>
  <div class="analytics-kpi-grid">
   ${statCard('clock',minutes,'分',rangeTitle+'の読書時間')}
   ${statCard('target',average??'—',average===null?'':'%',`テスト平均 · ${tests.length}回`)}
   ${statCard('chart',avgWpm??'—',avgWpm===null?'':'WPM',`演習読書速度 · ${speeds.length}回`)}
   ${statCard('cards',reviewPct??'—',reviewPct===null?'':'%',`自己評価「覚えた・簡単」 · ${reviews.length}回`)}
  </div>
  <div class="analytics-grid">
   <section class="card analytics-panel"><div class="analytics-panel-head"><div><h2>読解テストの正答率</h2><p>${scores.length}回のテスト · %</p></div><span class="analytics-label">理解度</span></div>${chartLine(scores,'正答率',{unit:'%',maxY:100,stroke:'#6277cc'})}</section>
   <section class="card analytics-panel"><div class="analytics-panel-head"><div><h2>リーディング速度（WPM）</h2><p>${speeds.length}回の有効な計測 · 語/分</p></div><span class="analytics-label">速読</span></div>${chartLine(speeds,'WPM',{stroke:'#228c83'})}</section>
   <section class="card analytics-panel"><div class="analytics-panel-head"><div><h2>読書した時間</h2><p>${activeDays}日の学習記録 · 分/学習日</p></div><span class="analytics-label">習慣</span></div>${chartLine(readingDailyPoints(sessions),'読書時間',{unit:'分',stroke:'#c08748'})}</section>
   <section class="card analytics-panel"><div class="analytics-panel-head"><div><h2>単語復習の自己評価</h2><p>${reviews.length}回の評価 · 日ごとの「覚えた・簡単」割合</p></div><span class="analytics-label">語彙</span></div>${chartLine(reviewPoints,'復習の自己評価',{unit:'%',maxY:100,stroke:'#9e70af'})}</section>
  </div>
  <div class="analytics-detail-grid">
   <section class="card analytics-panel"><h2>読解問題の種類別分析</h2><p class="small muted analytics-description">正答・誤答が保存された問題のみ集計。問題が少ない場合は暫定的な傾向です。</p>
    ${typeStats.rows.length?`<div class="analytics-type-list">${typeStats.rows.map(s=>{const pct=Math.round(s.correct/s.total*100);return `<div class="analytics-type-row"><div class="analytics-type-label"><b>${E(QUIZ_TYPES[s.type])}</b><span>${pct}% · ${s.correct}/${s.total}問${s.total<3?' · 参考値':''}</span></div><div class="analytics-bar"><div style="width:${pct}%" class="${pct<60?'needs-work':pct>=80?'is-good':''}"></div></div></div>`}).join('')}</div>`:'<div class="analytics-empty small">種類別に集計できる問題の解答履歴がありません。まず読解テストを受けてください。</div>'}
   </section>
   <section class="card analytics-panel"><h2>学習履歴からのおすすめ</h2><p class="small muted analytics-description">ローカルデータに基づくルール式の提案です。AI診断や英語力の認定ではありません。</p>
    <div class="analytics-rec-list">${recs.map((r,i)=>`<article class="analytics-rec"><div class="analytics-rec-icon">${ico(r.icon,20)}</div><div><h3>${E(r.title)}</h3><p>${r.why}</p><button class="btn sm soft" data-act="${E(r.action)}" ${r.id?`data-id="${E(r.id)}"`:''} ${r.view?`data-view="${E(r.view)}"`:''}>${E(r.button)} ${ico('arrow',13)}</button></div></article>`).join('')}</div>
   </section>
  </div>
  <section class="card analytics-panel analytics-lower"><div class="analytics-panel-head"><div><h2>AIによる学習傾向のコメント（任意）</h2><p>APIを設定した場合だけ使える追加機能。集計値のみ送信します。</p></div></div>
   <div class="analytics-ai-actions"><button class="btn soft" data-act="analytics-ai" ${analyticsAiLoading?'disabled':''}>${ico('sparkles',16)} ${analyticsAiLoading?'分析中…':'集計データをAIで解説'}</button><span class="small muted">教材本文・単語・個人情報は送信しません。確認後に送信します。</span></div>
   ${analyticsAiResult&&analyticsAiRange===range?`<div class="note-box analytics-ai-result" role="status">${E(analyticsAiResult)}</div>`:''}
   </section>
  <section class="card analytics-panel analytics-lower"><div class="analytics-panel-head"><div><h2>教材の登録レベル別・テスト平均</h2><p>登録されたCEFRレベル別の結果。英語力の判定ではありません。</p></div></div>
   ${levels.length?`<div class="analytics-level-grid">${levels.map(g=>`<div class="analytics-level-item"><strong>${E(g.level)}</strong><span>平均 ${Math.round(g.score/g.count*100)}% · ${g.count}回</span><span>WPM ${g.wpmCount?Math.round(g.wpmSum/g.wpmCount):'—'}</span></div>`).join('')}</div>`:'<div class="analytics-empty">この期間の教材レベル付きテスト記録がありません。</div>'}</section>
  <section class="card analytics-panel analytics-lower"><div class="analytics-panel-head"><div><h2>教材ごとの進捗</h2><p>教材の登録レベルは実力判定ではありません</p></div></div>${db.materials.length?`<div class="analytics-progress-list">${db.materials.map(m=>{const p=getP(m.id);const pct=Math.max(0,Math.min(100,Number(p.percent)||0));return `<div class="analytics-progress-item"><div class="reading-status"><span class="semibold small">${E(m.title)} <small class="muted">${E(m.level)}</small></span><span class="small muted">${pct}%</span></div><div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div></div>`;}).join('')}</div>`:'<div class="analytics-empty">教材がありません。</div>'}</section>
  <section class="card analytics-panel analytics-lower"><div class="analytics-panel-head"><div><h2>最近の読解テスト</h2><p>選択した分析期間内の最新12件</p></div></div>${recent.length?`<div class="quiz-history-scroll"><table class="quiz-history"><thead><tr><th>日付</th><th>教材</th><th>正答率</th><th>WPM</th><th>解答時間</th></tr></thead><tbody>${recent.map(t=>`<tr><td>${E(niceDate(t.date))}</td><td>${E(getM(t.materialId)?.title||'削除済み教材')}</td><td>${Math.round(t.score/t.total*100)}% (${t.score}/${t.total})</td><td>${Number.isFinite(t.wpm)?Math.round(t.wpm):'—'}</td><td>${Number.isFinite(t.elapsedSeconds)?formatTime(t.elapsedSeconds):'—'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="analytics-empty">この期間のテスト履歴はありません。</div>'}</section>
  <p class="analytics-method muted">集計について：読書時間は終了・画面移動時に記録された読書セッション、正答率とWPMは保存済みテスト、復習は現在のカードに保存された自己評価履歴から算出します。削除した教材・カードの関連履歴は集計対象外です。過去に計測していない項目は推定しません。復習の「難しい」は成功に含めていません。読書速度は演習モードで本文末まで読み、10秒以上計測した場合のみ保存されます。</p>
 </div>`;
}
// v1.0: IndexedDB backup snapshots. Backups are local to the browser origin.
function openSnapshotDB(){
 return new Promise((resolve,reject)=>{
  if(!('indexedDB' in window))return reject(Error('このブラウザは自動バックアップに対応していません'));
  const req=indexedDB.open(SNAPSHOT_DB,1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('snapshots'))req.result.createObjectStore('snapshots',{keyPath:'id'});};
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(req.error||Error('バックアップ領域を開けませんでした'));
 });
}
async function snapshotStore(record){
 const database=await openSnapshotDB();
 try{
  await new Promise((resolve,reject)=>{const tx=database.transaction('snapshots','readwrite');tx.objectStore('snapshots').put(record);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
 }finally{database.close();}
}
async function snapshotList(){
 const database=await openSnapshotDB();
 try{return await new Promise((resolve,reject)=>{const tx=database.transaction('snapshots','readonly');const req=tx.objectStore('snapshots').getAll();req.onsuccess=()=>resolve(req.result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));req.onerror=()=>reject(req.error);});}
 finally{database.close();}
}
async function snapshotDelete(id){
 const database=await openSnapshotDB();
 try{await new Promise((resolve,reject)=>{const tx=database.transaction('snapshots','readwrite');tx.objectStore('snapshots').delete(id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
 finally{database.close();}
}
async function snapshotCreate(kind='manual'){
 const now=new Date().toISOString(),id=kind+'-'+now+'-'+Math.random().toString(36).slice(2,7);
 const contents=JSON.stringify(db);
 await snapshotStore({id,kind,createdAt:now,bytes:new Blob([contents]).size,data:contents});
 const existing=await snapshotList();
 // Keep the most recent 8 snapshots; 7-day automatic history plus a safety margin.
 for(const old of existing.slice(8))await snapshotDelete(old.id);
 return id;
}
async function queueDailySnapshot(){
 if(snapshotBusy||!window.indexedDB)return;
 const now=new Date();const day=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
 if(localStorage.getItem(AUTO_SNAPSHOT_DAY)===day)return;
 snapshotBusy=true;
 try{await snapshotCreate('auto');localStorage.setItem(AUTO_SNAPSHOT_DAY,day);}catch(err){console.warn('自動スナップショットを保存できませんでした:',err);}
 finally{snapshotBusy=false;}
}
async function updateSnapshotList(){
 const el=$('#snapshotList');if(!el)return;
 try{const list=await snapshotList();if(!el.isConnected)return;
  el.innerHTML=list.length?list.map(r=>`<div class="snapshot-row"><div><strong>${E(new Date(r.createdAt).toLocaleString('ja-JP'))}</strong><div class="small muted">${r.kind==='auto'?'自動':r.kind==='safety'?'復元前の保護':'手動'} · ${Math.ceil(r.bytes/1024).toLocaleString()} KB</div></div><div class="button-row"><button class="btn sm" data-act="snapshot-restore" data-id="${E(r.id)}">復元</button><button class="btn sm danger" data-act="snapshot-delete" data-id="${E(r.id)}">削除</button></div></div>`).join(''):'<p class="small muted">端末内の復元ポイントはまだありません。</p>';
 }catch(err){if(el.isConnected)el.textContent='この環境では端末内の自動バックアップを利用できません。JSON書き出しをご利用ください。';}
}
function checkBackupShape(x){
 if(!x||typeof x!=='object'||Array.isArray(x)||!Array.isArray(x.materials)||!Array.isArray(x.saved)||!x.progress||typeof x.progress!=='object'||Array.isArray(x.progress)||!x.settings||typeof x.settings!=='object'||Array.isArray(x.settings))throw Error('Reading Labのバックアップ形式ではありません');
 if(x.folders&&(!Array.isArray(x.folders.materials)||!Array.isArray(x.folders.saved)||x.folders.materials.length>500||x.folders.saved.length>500))throw Error('フォルダ情報が不正です');
 if(x.materials.length>2000||x.saved.length>100000||x.materials.some(m=>!m||typeof m.id!=='string'||typeof m.text!=='string'||m.text.length>150000))throw Error('バックアップに不正な教材情報が含まれています');
}
function applyBackupData(parsed){
 checkBackupShape(parsed);
 if(currentView==='reader')stopSession();
 db=normalizeState(parsed);
 if(storageProblem?.kind==='corrupt')storageProblem=null; // Explicit import/restore is user-approved replacement.
 reviewSession=null;reviewFilter='all';reviewSearch='';folderView={materials:'all',saved:'all'};bulkSelected={materials:new Set(),saved:new Set()};folderCollapsed={materials:new Set(),saved:new Set()};currentId=null;activeQuiz=null;currentView='home';persist();renderShell();
}
async function restoreSnapshot(id){
 try{const list=await snapshotList(),entry=list.find(x=>x.id===id);if(!entry)throw Error('復元ポイントが見つかりません');
  if(!confirm('現在の教材・履歴をこの復元ポイントで置き換えます。よろしいですか？'))return;
  await snapshotCreate('safety');applyBackupData(JSON.parse(entry.data));storeSyncRevision(null);notify('復元ポイントからデータを戻しました');
 }catch(err){notify('復元できません：'+err.message);}
}
// A private, manually operated sync endpoint on the optional Node server.
function syncRevision(){try{return localStorage.getItem(SYNC_REVISION_KEY)||null;}catch{return null;}}
function storeSyncRevision(rev){try{if(rev)localStorage.setItem(SYNC_REVISION_KEY,rev);else localStorage.removeItem(SYNC_REVISION_KEY);}catch{}}
async function syncRequest(method='GET',payload){
 if(!syncToken)throw Error('先に同期用トークンを入力してください');
 if(location.protocol==='file:')throw Error('HTML単体版では利用できません。Nodeサーバーでアプリを開いてください');
 const res=await fetch('/api/sync',{method,headers:{'Authorization':'Bearer '+syncToken,...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,cache:'no-store',signal:AbortSignal.timeout(14000)});
 const body=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(body.error||('同期サーバーのエラー '+res.status));
 return body;
}
async function checkSyncServer(){
 syncToken=$('#syncToken')?.value.trim()||syncToken;
 try{const result=await syncRequest();syncRemoteInfo={revision:result.revision||null,updatedAt:result.updatedAt||null};
 const t=$('#syncStatus');if(t)t.textContent=result.revision?`同期サーバー接続済み。最終更新：${new Date(result.updatedAt).toLocaleString('ja-JP')}`:'接続済み。サーバーにはまだデータがありません。';
 notify('同期サーバーに接続しました');
 }catch(err){syncRemoteInfo=null;const t=$('#syncStatus');if(t)t.textContent=err.message;notify('接続失敗：'+err.message);}
}
async function pushSync(){
 try{
  const remote=await syncRequest();const expected=syncRevision();
  if(remote.revision&&remote.revision!==expected)throw Error('サーバーに未取得の変更があります。先に受信して内容を確認してください（自動統合はしません）');
  if(!confirm('この端末の学習データでサーバー上のデータを更新しますか？'))return;
  const result=await syncRequest('PUT',{data:db,expectedRevision:expected});storeSyncRevision(result.revision);syncRemoteInfo=result;notify('同期サーバーへ送信しました');
  if($('#syncStatus'))$('#syncStatus').textContent=`送信完了：${new Date(result.updatedAt).toLocaleString('ja-JP')}`;
 }catch(err){notify('送信できません：'+err.message);}
}
async function pullSync(){
 try{const remote=await syncRequest();if(!remote.data)throw Error('サーバーにデータがありません');
  checkBackupShape(remote.data);
  if(!confirm('サーバー上のデータで現在の教材・学習履歴を置き換えます。端末側の未送信の変更は統合されません。続けますか？'))return;
  await snapshotCreate('safety');applyBackupData(remote.data);storeSyncRevision(remote.revision);syncRemoteInfo={revision:remote.revision,updatedAt:remote.updatedAt};notify('サーバーのデータを受信しました。端末内の復元ポイントも作成済みです。');
 }catch(err){notify('受信できません：'+err.message);}
}
function setupPWA(){
 window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e;if(currentView==='settings')renderPage();});
 window.addEventListener('appinstalled',()=>{installEvent=null;notify('アプリをインストールしました');if(currentView==='settings')renderPage();});
 if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost'||location.hostname==='127.0.0.1')){
  navigator.serviceWorker.register('./sw.js').catch(e=>console.warn('オフラインキャッシュ登録失敗',e));
 }
}
async function installPWA(){
 if(isIOSDevice()||!installEvent){showInstallGuide();return;}
 if(!installEvent){notify('ブラウザメニューの「アプリをインストール」または「ホーム画面に追加」をご利用ください');return;}
 const prompt=installEvent;installEvent=null;await prompt.prompt();await prompt.userChoice;
}
function renderSettings(){return `<div class="page-wrap">${header('設定','表示・音声・学習データを管理します。')}<div class="card card-pad" style="max-width:760px"><h2 class="card-title">読書環境</h2><div class="settings-group"><div><h3>ダークモード</h3><p>目にやさしい暗色の画面に切り替えます。</p></div><button class="btn" data-act="dark">${ico(db.settings.dark?'moon':'sun')} ${db.settings.dark?'オン':'オフ'}</button></div><div class="settings-group"><div><h3>文字サイズ</h3><p>本文の基本文字サイズを調整します。</p></div><div class="button-row"><button class="btn sm" data-act="font-minus">A−</button><span class="small semibold" id="settingsFont">${db.settings.fontSize}px</span><button class="btn sm" data-act="font-plus">A＋</button></div></div><div class="settings-group"><div><h3>読み上げ速度</h3><p>ブラウザの英語音声で読み上げます。</p></div><select class="select-input" id="voiceRate"><option value="0.75" ${db.settings.voiceRate===0.75?'selected':''}>ゆっくり（0.75倍）</option><option value="0.9" ${db.settings.voiceRate===0.9?'selected':''}>少しゆっくり（0.9倍）</option><option value="1" ${db.settings.voiceRate===1?'selected':''}>標準（1.0倍）</option><option value="1.2" ${db.settings.voiceRate===1.2?'selected':''}>速め（1.2倍）</option></select></div><h2 class="card-title" style="margin-top:30px">無料のオフライン英和辞書</h2><div class="settings-group"><div><h3>内蔵辞書・追加辞書</h3><p id="offlineDictionaryStatus">内蔵英和 ${Object.keys(OFFLINE_CORE).length.toLocaleString('ja-JP')}語 + 追加辞書 ${importedDictionaryCount.toLocaleString('ja-JP')}語</p><p>一般的な語義をネット接続なしで表示します。追加データとして<a href="https://github.com/kujirahand/EJDict" target="_blank" rel="noopener noreferrer">EJDict（CC0）</a>を取り込めます。</p></div><button class="btn" data-act="choose-dictionary">${ico('upload',15)} 辞書を読み込む</button><input class="hidden" type="file" id="dictionaryFile" accept=".txt,.tsv,.json,text/plain,application/json"></div><div class="settings-group"><div><h3>追加辞書を削除</h3><p>後から取り込んだ辞書だけを削除します。内蔵英和や学習履歴は残ります。</p></div><button class="btn sm danger" data-act="clear-dictionary" ${!importedDictionaryCount?'disabled':''}>${ico('trash',14)} 削除</button></div><div class="callout" style="margin-bottom:16px">追加するにはEJDict配布ページからTXTまたはJSON形式を入手し、ZIPを展開してから選択してください。辞書データは端末内に保存され、バックアップJSONには含まれません。</div><div class="callout" style="margin-bottom:16px">v1.1: 辞書にない語句はリーディング画面の「語義を登録・修正」で自分の訳を保存できます。和訳がない英文では、無料の語句ガイドと文法ヒントを表示します。個人辞書はバックアップJSONに含まれます。</div><h2 class="card-title" style="margin-top:30px">データ管理</h2><div class="settings-group"><div><h3>バックアップを保存・共有</h3><p>iPhoneでは「共有して保存」から「ファイルに保存」を選べます。</p></div><div class="button-row"><button class="btn" data-act="share-backup">${ico('download')} 共有して保存</button><button class="btn" data-act="export">JSON書き出し</button></div></div><div class="settings-group"><div><h3>バックアップを復元</h3><p>保存したJSONファイルを読み込みます。現在のデータを置き換えます。</p></div><button class="btn" data-act="import-backup">${ico('upload')} 読み込む</button></div><h2 class="card-title" style="margin-top:30px">v1.5.1 · スマホ・インストール・データ保護</h2><div class="settings-group"><div><h3>アプリとしてインストール</h3><p>iPhoneは公開したHTTPSサイトをSafariで開き、共有メニューから「ホーム画面に追加」。HTML単体版ではPWAになりません。</p></div><button class="btn" data-act="install-app">${ico('download')} 追加方法を見る</button></div><div class="settings-group"><div><h3>復元ポイントを作成</h3><p>端末内にスナップショットを保存します。初回の変更時と、日付が変わった後の保存時にも自動作成（最大8件）。ブラウザのデータを削除すると失われるため、JSON書き出しも併用してください。</p></div><button class="btn" data-act="snapshot-create">${ico('cards')} 今すぐ保存</button></div><div id="snapshotList" class="snapshot-list" aria-live="polite">復元ポイントを確認中…</div>${STATIC_DEPLOY?'<div class="callout">この公開用Web版は端末ごとに学習データを保存します。サーバー同期とAI解析は利用できません。端末移行には「バックアップを共有」→別端末で「バックアップを復元」を利用してください。</div>':''}<div class="${STATIC_DEPLOY?'hidden':''}"><h2 class="card-title" style="margin-top:30px">複数端末間の手動同期（任意）</h2><p class="small muted" style="line-height:1.8">同じReading LabのNodeサーバー（HTTPS推奨）に各端末から接続して「送信・受信」を手動で行います。データの自動統合はしません。未送信の変更がある端末で受信すると、その変更は上書きされます。同期にはサーバー側で READING_LAB_SYNC_TOKEN（空白なし）を設定する必要があります。</p><div class="settings-group"><div><h3>同期用トークン</h3><p>この画面を開いている間だけ保持します。ブラウザの保存領域には保存しません。</p></div><input id="syncToken" class="select-input" type="password" autocomplete="off" placeholder="サーバーのトークンを入力" value="${E(syncToken)}" /></div><div class="button-row sync-actions"><button class="btn sm" data-act="sync-check">接続確認</button><button class="btn sm" data-act="sync-push">この端末 → サーバー</button><button class="btn sm" data-act="sync-pull">サーバー → この端末</button></div><p id="syncStatus" class="small muted" role="status">同じサーバーに接続できる端末間で利用できます。</p><div class="settings-group"><div><h3>AI解説の接続</h3><p>APIキーはブラウザに保存しません。別途サーバーで設定します。</p></div><button class="btn" data-act="check-api">${ico('info')} 接続確認</button></div></div></div><div class="callout" style="max-width:760px;margin-top:17px">無料で使える範囲：対訳の手入力・構文メモ・マーカー・内蔵熟語辞書・読書・登録・保存・音声・内蔵英和辞書・追加英和辞書・オンライン英英辞書・内蔵サンプル解説・自作四択テスト。新しい英文のAI翻訳・構文解説・AIテスト生成には、サーバー側のAPI設定が必要です。API利用料が発生する場合があります。</div></div>`;}
// v0.1.4: Offline phrase glossary and per-sentence annotations. No AI/API needed for notes.
const PHRASE_GLOSSARY={
 'at the edge of':'～の端に', 'for more than':'～を超える期間', 'more than':'～より多い／単なる～ではない',
 'were reluctant to':'～するのをためらっていた', 'be reluctant to':'～することに気が進まない',
 'nothing more than':'単なる～にすぎない', 'after sunset':'日没後に', 'for decades':'何十年もの間',
 'at first':'最初は', 'to her surprise':'彼女が驚いたことに', 'to his surprise':'彼が驚いたことに',
 'pick up':'拾い上げる／身につける', 'picked up':'拾い上げた', 'had become':'～になっていた',
 'by the end of':'～が終わるまでに', 'no longer':'もはや～ない', 'over time':'時間の経過とともに',
 'be afraid of':'～を恐れる', 'afraid of':'～を恐れる', 'instead of':'～の代わりに',
 'in front of':'～の前に', 'in spite of':'～にもかかわらず', 'because of':'～が原因で',
 'as a result':'その結果', 'on the other hand':'一方で', 'for example':'例えば',
 'such as':'～のような', 'according to':'～によれば', 'as soon as':'～するとすぐに',
 'even though':'～にもかかわらず', 'in order to':'～するために', 'rather than':'～よりむしろ',
 'not only':'～だけでなく', 'as well as':'～と同様に／～に加えて', 'used to':'以前はよく～した',
 'have to':'～しなければならない', 'take care of':'～の世話をする', 'look forward to':'～を楽しみに待つ',
 'a number of':'いくつかの／多数の', 'give up':'あきらめる', 'look up':'調べる／見上げる',
 'make sure':'確実にする', 'in addition to':'～に加えて', 'each other':'お互いに',
 'one of the':'～のうちの一つ', 'is likely to':'～する可能性が高い', 'due to':'～のために'
};
Object.assign(PHRASE_GLOSSARY,{
 'in the middle of':'～の真ん中に','as long as':'～である限り','even if':'たとえ～でも','as if':'まるで～のように',
 'in case of':'～の場合','in case':'～に備えて／もし～なら','as a matter of fact':'実際のところ',
 'on the contrary':'それどころか／反対に','in contrast to':'～とは対照的に','by contrast':'それに対して',
 'in other words':'言い換えると','in fact':'実際に','at least':'少なくとも','at most':'多くても',
 'so that':'～するために／その結果～するように','so as to':'～するために','so far':'これまでのところ',
 'as far as':'～する限り／～まで','as well':'～もまた','in terms of':'～の観点から',
 'in particular':'特に','in general':'一般に','in the past':'過去に','at the same time':'同時に',
 'for the sake of':'～のために','in exchange for':'～と引き換えに','in charge of':'～を担当して',
 'be responsible for':'～に責任がある','be interested in':'～に興味がある','be likely to':'～しそうである',
 'have been':'～であった／～してきた','has been':'～であった／～してきた','had been':'～であった（過去完了）',
 'take part in':'～に参加する','take place':'起こる／開催される','put off':'延期する',
 'come up with':'思いつく','run out of':'～を使い果たす','depend on':'～に依存する／～次第である',
 'deal with':'～に対処する／～を扱う','lead to':'～につながる','result in':'～という結果になる',
 'result from':'～に起因する','keep in mind':'心に留める','pay attention to':'～に注意を払う',
 'in order that':'～するために','regardless of':'～にかかわらず','owing to':'～のために',
 'in addition':'さらに','in conclusion':'結論として','on behalf of':'～を代表して',
 'be supposed to':'～することになっている','a great deal of':'大量の','not necessarily':'必ずしも～ではない',
 'no matter how':'どんなに～でも','as a consequence':'その結果','rather than':'～ではなく／～よりむしろ',
 'in relation to':'～に関連して','with regard to':'～に関して','as opposed to':'～とは対照的に',
 'provided that':'～という条件で','in the meantime':'その間に','along with':'～と一緒に',
 'in response to':'～に応じて','for instance':'例えば','the fact that':'～という事実',
 'such that':'～するような／～となるように','not until':'～して初めて',
 'be able to':'～することができる','would rather':'むしろ～したい'
});
const PHRASE_KEYS=Object.keys(PHRASE_GLOSSARY).sort((a,b)=>b.length-a.length);
const PHRASE_MATCHER=new RegExp('\\b(?:'+PHRASE_KEYS.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')\\b|[A-Za-z]+(?:[\\x27\\u2019][A-Za-z]+)?','gi');
let personalPhraseSignature=null,personalPhraseMatcher=PHRASE_MATCHER;
function activePhraseMatcher(){
 const keys=Object.keys(db.userGloss||{}).filter(k=>k.includes(' ')&&k.length<=120&&/^[a-z' -]+$/.test(k));
 const signature=keys.slice().sort().join('\n');
 if(signature!==personalPhraseSignature){
  personalPhraseSignature=signature;
  if(keys.length){
   const all=[...new Set([...PHRASE_KEYS,...keys])].sort((a,b)=>b.length-a.length);
   const escaped=all.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
   personalPhraseMatcher=new RegExp('\\b(?:'+escaped.join('|')+')\\b|[A-Za-z]+(?:[\\x27\\u2019][A-Za-z]+)?','gi');
  }else personalPhraseMatcher=PHRASE_MATCHER;
 }
 return personalPhraseMatcher;
}
function getPhraseEntry(input){
 const key=normalizedDictKey(input).replace(/^[^a-z]+|[^a-z]+$/g,'');
 const user=db?.userGloss?.[key];if(user)return {ja:user.ja,headword:key,source:'自分で登録した語義',usage:user.memo||''};
 if(PHRASE_GLOSSARY[key])return {ja:PHRASE_GLOSSARY[key],headword:key,source:'内蔵熟語辞典',usage:'表現全体の意味です。前後の文脈で訳が変わる場合があります。'};
 if(/^(?:was|were|is|are|am|been|being) reluctant to$/.test(key))return {ja:PHRASE_GLOSSARY['be reluctant to'],headword:'be reluctant to',source:'内蔵熟語辞典'};
 return key.includes(' ')?offlineEntry(key):null;
}
let sentenceCache={id:null,text:null,entries:[]};
function getArticleSentences(material=getM(currentId)){
 if(!material)return [];
 if(sentenceCache.id===material.id&&sentenceCache.text===material.text)return sentenceCache.entries;
 const entries=material.text.trim().split(/\n\s*\n/).flatMap(p=>splitSentences(p.trim()));
 sentenceCache={id:material.id,text:material.text,entries};return entries;
}
function sentenceTextAt(idx){return getArticleSentences()[idx]||'';}
function getSentenceNote(idx){
 const entry=db.notes?.[currentId]?.[String(idx)];
 return entry&&entry.source===sentenceTextAt(idx)?entry:null;
}
function sentenceTranslation(idx){
 const saved=getSentenceNote(idx)?.translation;
 return saved||syntaxInfo(idx).analysis?.translation||SAMPLE_EXPLANATIONS[sentenceTextAt(idx)]?.translate||'';
}
function sentenceGrammar(idx){return getSentenceNote(idx)?.grammar||syntaxInfo(idx).analysis?.grammar||SAMPLE_EXPLANATIONS[sentenceTextAt(idx)]?.grammar||'';}
// v1.2: syntax roles. Built-in examples are checked by hand; arbitrary text is NOT auto-parsed.
const SYNTAX_ROLES={
 S:{name:'主語',desc:'主語 (Subject)'}, V:{name:'動詞',desc:'動詞 (Verb)'},
 O:{name:'目的語',desc:'目的語 (Object)'}, C:{name:'補語',desc:'補語 (Complement)'},
 M:{name:'修飾',desc:'修飾語・副詞節 (Modifier)'}
};
const SYNTAX_DEMOS={
 'The old house had stood at the edge of the village for more than a century.':[
  ['S','The old house'],['V','had stood'],['M','at the edge of the village'],['M','for more than a century']],
 'Although nobody had lived there for decades, the villagers were reluctant to approach it.':[
  ['M','Although nobody had lived there for decades'],['S','the villagers'],['V','were'],['C','reluctant to approach it']],
 'Some claimed that strange noises could be heard from inside after sunset.':[
  ['S','Some'],['V','claimed'],['O','that strange noises could be heard from inside after sunset']],
 'When Daniel was a student, he was afraid of speaking English.':[
  ['M','When Daniel was a student'],['S','he'],['V','was'],['C','afraid of speaking English']],
 'Trees reduce heat in two important ways.':[
  ['S','Trees'],['V','reduce'],['O','heat'],['M','in two important ways']],
 'Nobody laughed when Daniel made a mistake.':[
  ['S','Nobody'],['V','laughed'],['M','when Daniel made a mistake']]
};
function curatedSyntax(source){
 const spec=SYNTAX_DEMOS[source];if(!spec)return [];
 const taken=[];
 for(const [role,phrase] of spec){const start=source.indexOf(phrase);if(start<0||taken.some(a=>start<a.end&&start+phrase.length>a.start))continue;taken.push({role,start,end:start+phrase.length});}
 return taken;
}
function syntaxInfo(idx){
 const source=sentenceTextAt(idx),saved=db.syntaxAnnotations?.[currentId]?.[String(idx)];
 if(saved&&saved.source===source&&Array.isArray(saved.items)){
  return {items:saved.items.filter(x=>SYNTAX_ROLES[x.role]&&Number.isInteger(x.start)&&Number.isInteger(x.end)&&x.start>=0&&x.end<=source.length&&x.start<x.end),mode:saved.origin==='ai'?'ai':'manual',analysis:saved.analysis||null};
 }
 const demo=curatedSyntax(source);
 return {items:demo,mode:demo.length?'sample':'none'};
}
function rolePills(){return Object.entries(SYNTAX_ROLES).map(([r,v])=>`<span class="syntax-legend-chip syntax-legend-${r.toLowerCase()}" title="${E(v.desc)}"><b>${r}</b> ${E(v.name)}</span>`).join('');}
function syntaxTagRange(role){
 if(readerMode!=='study')return;
 const selected=panelSelection,idx=selected?.sentenceIndex;
 if(!selected||!Number.isInteger(idx)||!Number.isInteger(selected.start)||!Number.isInteger(selected.end)||!SYNTAX_ROLES[role]){notify('同じ一文の中で、ラベルを付けたい範囲をドラッグして選択してください');return;}
 const source=sentenceTextAt(idx),start=selected.start,end=selected.end;
 if(start<0||end>source.length||start>=end){notify('選択範囲を取得できませんでした');return;}
 const existing=syntaxInfo(idx).items;
 // A range can have only one role. A new assignment replaces intersecting roles;
 // unlike marks, syntax colors must not overlap and imply competing interpretations.
 const changed=existing.filter(x=>x.end<=start||x.start>=end);
 changed.push({role,start,end});changed.sort((a,b)=>a.start-b.start);
 db.syntaxAnnotations||={};db.syntaxAnnotations[currentId]||={};
 const previous=db.syntaxAnnotations[currentId][String(idx)];
 db.syntaxAnnotations[currentId][String(idx)]={source,items:changed,origin:'manual',analysis:previous?.source===source?previous.analysis:null,updatedAt:new Date().toISOString()};
 persist();refreshArticlePreservingScroll();renderInsightPanel();removeFloatingToolbar();
 notify(`${role}（${SYNTAX_ROLES[role].name}）を付けました`);
}
// v1.3: Validate machine-produced role offsets against the exact original sentence.
// Wrong offsets, ambiguous repeated phrases, and overlapping role spans are discarded.
function normalizeAiSyntax(source,raw){
 if(typeof source!=='string'||source.length<3||source.length>650||!raw||typeof raw!=='object')throw Error('構文解析の形式が正しくありません');
 if(!Array.isArray(raw.items)||!Array.isArray(raw.clauses))throw Error('構文ラベルの形式が正しくありません');
 const result=[];
 for(const candidate of raw.items.slice(0,30)){
  if(!candidate||!SYNTAX_ROLES[candidate.role]||typeof candidate.quote!=='string')continue;
  const quote=candidate.quote;
  if(!quote||quote.length>source.length)continue;
  const requestedStart=Number(candidate.start),requestedEnd=Number(candidate.end);
  let start=-1,end=-1;
  if(Number.isInteger(requestedStart)&&requestedStart>=0&&source.slice(requestedStart,requestedEnd)===quote&&requestedEnd===requestedStart+quote.length){start=requestedStart;end=requestedEnd;}
  else{
   // Exact matching is safe when there is only one occurrence in the sentence.
   const first=source.indexOf(quote);
   if(first>=0&&source.indexOf(quote,first+1)<0){start=first;end=first+quote.length;}
  }
  if(start<0||start>=end||end>source.length)continue;
  if(result.some(r=>r.start<end&&start<r.end))continue;
  result.push({role:candidate.role,start,end,reason:String(candidate.reason||'').slice(0,250)});
 }
 result.sort((a,b)=>a.start-b.start);
 if(!result.length)throw Error('原文に対応する構文ラベルを確認できませんでした。もう一度お試しください');
 const clauses=raw.clauses.slice(0,12).filter(v=>v&&typeof v.quote==='string'&&source.includes(v.quote)&&typeof v.kind==='string'&&typeof v.explanation==='string').map(v=>({quote:v.quote.slice(0,650),kind:v.kind.slice(0,100),explanation:v.explanation.slice(0,700)}));
 return {items:result,analysis:{translation:String(raw.translation||'').slice(0,1600),grammar:String(raw.grammar||'').slice(0,2500),clauses}};
}
async function analyzeSyntaxAI(idx){
 if(readerMode!=='study'||syntaxAiBusy)return;
 const id=currentId,source=sentenceTextAt(idx),materialText=getM(currentId)?.text;
 if(!id||!source){notify('解析したい一文を選択してください');return;}
 if(source.length>650){notify('この文は長すぎるため自動解析できません。650文字以内の文を選んでください');return;}
 const existing=db.syntaxAnnotations?.[id]?.[String(idx)];
 if(existing?.source===source&&existing.items?.length&&!confirm('この文の既存ラベルをAIの結果で置き換えますか？ 和訳・文法メモは維持します。'))return;
 syntaxAiBusy=true;
 const status=$('#syntaxAiStatus');if(status)status.textContent='AI構文解析中です…';
 document.querySelectorAll('[data-act="syntax-ai"]').forEach(el=>{el.disabled=true;});
 try{
  const response=await aiRequest('syntax',{text:source,context:'原文と同じ順番で語句にラベルを付ける。教材の前後文脈は参考情報であり、解析対象は一文だけ。'});
  const normalized=normalizeAiSyntax(source,JSON.parse(response));
  if(!getM(id)||getM(id).text!==materialText||sentenceTextAt(idx)!==source||currentId!==id){notify('解析中に教材が変わったため結果を保存しませんでした');return;}
  db.syntaxAnnotations||={};db.syntaxAnnotations[id]||={};
  db.syntaxAnnotations[id][String(idx)]={source,items:normalized.items,analysis:normalized.analysis,origin:'ai',updatedAt:new Date().toISOString()};
  db.settings.syntaxEnabled=true;
  persist();
  if(currentView==='reader'&&readerMode==='study'&&currentId===id){
   const wasEditor=!!$('#modal')?.querySelector('#syntaxTitle');
   refreshArticlePreservingScroll();
   if(wasEditor)showSyntaxEditor(idx);
   if(panelSelection?.sentenceIndex===idx)renderInsightPanel();
  }
  notify('AI解析を保存しました。ラベルと節の説明を確認し、必要なら手動修正してください');
 }catch(err){notify('AI構文解析：'+(err.message||String(err)));const status=$('#syntaxAiStatus');if(status)status.textContent=err.message||'解析に失敗しました';}
 finally{syntaxAiBusy=false;document.querySelectorAll('[data-act="syntax-ai"]').forEach(el=>{el.disabled=false;});}
}
function syntaxRemoveAt(idx,i){
 if(readerMode!=='study')return;
 const source=sentenceTextAt(idx),existing=syntaxInfo(idx).items;
 if(!source||i<0||i>=existing.length)return;
 db.syntaxAnnotations||={};db.syntaxAnnotations[currentId]||={};
 const previous=db.syntaxAnnotations[currentId][String(idx)];
 db.syntaxAnnotations[currentId][String(idx)]={source,items:existing.filter((_,n)=>n!==i),origin:'manual',analysis:previous?.source===source?previous.analysis:null,updatedAt:new Date().toISOString()};
 persist();refreshArticlePreservingScroll();showSyntaxEditor(idx);notify('構文ラベルを解除しました');
}
function syntaxReset(idx){
 const source=sentenceTextAt(idx);if(!source||readerMode!=='study')return;
 // Reset restores verified samples, or clears all labels if no sample exists.
 if(db.syntaxAnnotations?.[currentId])delete db.syntaxAnnotations[currentId][String(idx)];
 persist();refreshArticlePreservingScroll();showSyntaxEditor(idx);notify('この文の構文ラベルを初期状態に戻しました');
}
function showSyntaxEditor(idx){
 if(readerMode!=='study'||!sentenceTextAt(idx))return;
 closeModal();const source=sentenceTextAt(idx),info=syntaxInfo(idx);
 const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';
 bg.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="syntaxTitle"><header class="modal-top"><h2 id="syntaxTitle">構文ラベルの管理</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body"><div class="note-box">${E(source)}</div><div class="syntax-legend">${rolePills()}</div><p class="small muted">${info.mode==='sample'?'この文には確認済みのサンプルラベルが付いています。変更すると自分用のラベルとして保存されます。':info.mode==='manual'?'この文には自分で設定したラベルが保存されています。':info.mode==='ai'?'AIが生成したラベルです。正確性を確認し、必要な場合は部分的に修正してください。':'この文はまだ色分けされていません。本文に戻り、範囲をドラッグしてS/V/O/C/Mを付けてください。'}</p><div class="syntax-editor-list">${info.items.length?info.items.map((item,i)=>`<div class="syntax-editor-item"><span class="syntax-legend-chip syntax-legend-${item.role.toLowerCase()}">${item.role} ${E(SYNTAX_ROLES[item.role].name)}</span><span class="syntax-editor-quote">${E(source.slice(item.start,item.end))}${item.reason?`<span class="small muted" style="display:block">${E(item.reason)}</span>`:''}</span><button class="btn sm" data-act="syntax-remove" data-index="${idx}" data-item="${i}">解除</button></div>`).join(''):'<p class="small muted">登録された構文ラベルはありません。</p>'}</div>${info.analysis?`<section class="ai-syntax-details"><h3>AIによる構文解説（要確認）</h3>${info.analysis.translation?`<p><strong>和訳</strong> ${E(info.analysis.translation)}</p>`:''}${info.analysis.grammar?`<div class="note-box">${E(info.analysis.grammar)}</div>`:''}${info.analysis.clauses?.length?`<h4>節の構造</h4>${info.analysis.clauses.map(cl=>`<div class="ai-syntax-clause"><strong>${E(cl.kind)}</strong><br><span lang="en">${E(cl.quote)}</span><br>${E(cl.explanation)}</div>`).join('')}`:''}</section>`:''}<div id="syntaxAiStatus" class="small muted" role="status">AIによる解析は誤判定する場合があります。構文を確認してから利用してください。</div><div class="callout">手動の構文ラベルはAPI不要。AIによる自動解析にはNodeサーバーとOpenAI APIキーが必要です（別途従量課金）。</div></div><footer class="modal-actions"><button class="btn sm soft" data-act="syntax-ai" data-index="${idx}" ${syntaxAiBusy?'disabled':''}>${ico('sparkles',14)} AIでこの文を解析</button><button class="btn" data-act="syntax-reset" data-index="${idx}">サンプルに戻す / 初期化</button><button class="btn primary" data-act="close-modal">閉じる</button></footer></section>`;
 document.body.appendChild(bg);
}

function markCount(){return (db.highlights||[]).filter(h=>h.materialId===currentId).length;}
function markersFor(idx){return (db.highlights||[]).filter(h=>h.materialId===currentId&&h.sentenceIndex===idx&&h.sentence===sentenceTextAt(idx));}
function phraseOrWordMarkup(text){
 if(readerMode==='exam')return E(text);
 const matcher=activePhraseMatcher();matcher.lastIndex=0;let out='',last=0,match;
 while((match=matcher.exec(text))!==null){
  out+=E(text.slice(last,match.index));const token=match[0];
  if(token.includes(' '))out+=`<span class="phrase" data-phrase="${E(token)}" title="クリックで熟語の意味を表示">${E(token)}</span>`;
  else out+=`<span class="word" data-word="${E(token)}" title="クリックで辞書を表示">${E(token)}</span>`;
  last=match.index+token.length;
 }
 return out+E(text.slice(last));
}
function tokenizeWithMarkers(text,idx){
 if(readerMode==='exam')return E(text);
 const marks=markersFor(idx).filter(h=>Number.isInteger(h.start)&&Number.isInteger(h.end)&&h.start>=0&&h.end<=text.length&&h.end>h.start);
 const roles=db.settings.syntaxEnabled?syntaxInfo(idx).items:[];
 if(!marks.length&&!roles.length)return phraseOrWordMarkup(text);
 const limits=[...new Set([0,text.length,...marks.flatMap(x=>[x.start,x.end]),...roles.flatMap(x=>[x.start,x.end])])].sort((a,b)=>a-b);
 let out='';for(let i=0;i<limits.length-1;i++){
  const start=limits[i],end=limits[i+1],section=text.slice(start,end),hit=marks.find(h=>h.start<=start&&h.end>=end),syntax=roles.find(x=>x.start<=start&&x.end>=end);
  let chunk=phraseOrWordMarkup(section);
  if(syntax)chunk=`<span class="syntax-span syntax-${syntax.role.toLowerCase()}" title="${E(syntax.role+' '+SYNTAX_ROLES[syntax.role].name+(syntax.reason?'：'+syntax.reason:''))}">${chunk}</span>`;
  if(hit)chunk=`<mark class="reading-mark ${E(hit.color||'yellow')}" title="マーカー">${chunk}</mark>`;
  out+=chunk;
 }
 return out;
}
function refreshArticlePreservingScroll(){
 if(currentView!=='reader')return;
 const sc=$('#readingScroll'),article=$('#readerArticle');if(!sc||!article)return;
 const pos=sc.scrollTop;article.innerHTML=renderArticle(getM(currentId));sc.scrollTop=pos;
}
function showSentence(idx){
 const text=sentenceTextAt(idx);if(!text||readerMode!=='study')return;
 panelSelection={text,kind:'sentence',context:text,sentenceIndex:idx};
 panelTab='translate';panelMessage=null;activeLookup=null;removeFloatingToolbar();renderInsightPanel();
}
function sentenceOffsetFromRange(range,sentenceElement,pointNode,pointOffset){
 const r=range.cloneRange();r.selectNodeContents(sentenceElement);r.setEnd(pointNode,pointOffset);return r.toString().length;
}
function toggleMarker(color='yellow'){
 if(!panelSelection||readerMode!=='study')return;
 const s=panelSelection,idx=s.sentenceIndex;
 if(!Number.isInteger(idx)){notify('一文の中の範囲、または一文を選択してください');return;}
 const source=sentenceTextAt(idx);let start=s.start,end=s.end;
 if(!Number.isInteger(start)||!Number.isInteger(end)){start=0;end=source.length;}
 if(start<0||end>source.length||start>=end){notify('マーカーの範囲を特定できませんでした');return;}
 const existing=db.highlights.find(h=>h.materialId===currentId&&h.sentenceIndex===idx&&h.start===start&&h.end===end&&h.sentence===source);
 if(existing){if(existing.color===color){db.highlights=db.highlights.filter(h=>h.id!==existing.id);notify('マーカーを解除しました');}else{existing.color=color;notify('マーカーの色を変更しました');}}
 else{db.highlights.push({id:'h'+Date.now()+Math.floor(Math.random()*10000),materialId:currentId,sentenceIndex:idx,start,end,quote:source.slice(start,end),sentence:source,color,createdAt:new Date().toISOString()});notify('マーカーを保存しました');}
 persist();refreshArticlePreservingScroll();renderInsightPanel();removeFloatingToolbar();
}
function removeMarker(id){
 db.highlights=db.highlights.filter(h=>h.id!==id);persist();refreshArticlePreservingScroll();renderInsightPanel();
 notify('マーカーを解除しました');
}
function showMarkerList(){
 if(!currentId)return;closeModal();
 const items=(db.highlights||[]).filter(h=>h.materialId===currentId&&h.sentence===sentenceTextAt(h.sentenceIndex));
 const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';
 bg.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="markerTitle"><header class="modal-top"><h2 id="markerTitle">マーカー一覧（${items.length}件）</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body marker-list">${items.length?items.map(h=>`<div class="marker-list-item"><span class="marker-dot ${E(h.color)}"></span><div class="marker-quote">${E(h.quote)}</div><button class="btn sm soft" data-act="jump-marker" data-index="${h.sentenceIndex}">本文へ</button><button class="btn sm danger" data-act="remove-marker" data-id="${E(h.id)}">解除</button></div>`).join(''):'<p class="small muted">まだマーカーはありません。本文を選択し、解説パネルのマーカーを押してください。</p>'}</div><footer class="modal-actions"><button class="btn" data-act="close-modal">閉じる</button></footer></section>`;
 document.body.appendChild(bg);
}
function openSentenceEditor(idx){
 if(!Number.isInteger(idx)||!sentenceTextAt(idx))return;
 const source=sentenceTextAt(idx),base=getSentenceNote(idx)||{},translation=base.translation||SAMPLE_EXPLANATIONS[source]?.translate||'',grammar=base.grammar||SAMPLE_EXPLANATIONS[source]?.grammar||'';
 closeModal();const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';bg.dataset.sentenceIndex=String(idx);
 bg.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="sentenceEditTitle"><header class="modal-top"><h2 id="sentenceEditTitle">一文の和訳・構文メモ</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body"><div class="note-box">${E(source)}</div><div class="field"><label for="sentenceJa">日本語訳</label><textarea id="sentenceJa" rows="4" maxlength="10000" placeholder="自分で訳した日本語を入力">${E(translation)}</textarea></div><div class="field"><label for="sentenceGrammar">文法・構文メモ</label><textarea id="sentenceGrammar" rows="5" maxlength="10000" placeholder="SVOCや節構造などを入力">${E(grammar)}</textarea></div><div class="callout">手動入力は無料で保存できます。AIで生成した説明は、解説パネルから呼び出した後にここへ保存されます。</div></div><footer class="modal-actions"><button class="btn" data-act="close-modal">キャンセル</button><button class="btn primary" data-act="save-sentence-note">${ico('check')} 保存</button></footer></section>`;
 document.body.appendChild(bg);$('#sentenceJa')?.focus();
}
function saveSentenceNote(){
 const idx=Number($('#modal')?.dataset.sentenceIndex),source=sentenceTextAt(idx);
 if(!source)return;
 const translation=$('#sentenceJa')?.value.trim()||'',grammar=$('#sentenceGrammar')?.value.trim()||'';
 db.notes ||= {};db.notes[currentId] ||= {};
 if(!translation&&!grammar)delete db.notes[currentId][String(idx)];
 else db.notes[currentId][String(idx)]={source,translation,grammar,updatedAt:new Date().toISOString()};
 persist();closeModal();refreshArticlePreservingScroll();
 if(panelSelection?.sentenceIndex===idx)renderInsightPanel();notify('和訳・構文メモを保存しました');
}
function getGrammarTips(text){
 // Heuristics deliberately say "可能性" or "確認". No implied complete parse.
 const tips=[];const src=String(text||'');
 if(/\b(although|though|even though|whereas)\b/i.test(src))tips.push('譲歩・対比の接続語（although / though / whereas など）：主節と対比して意味を整理します。');
 if(/\b(because|since|as)\b/i.test(src))tips.push('because / since / as：理由を表す用法があります（他の用法にも注意）。');
 if(/\b(if|unless|provided that)\b/i.test(src))tips.push('if / unless / provided that：条件を表す節の可能性があります。');
 if(/\b(when|while|before|after|until|as soon as)\b/i.test(src))tips.push('時を示す接続語：主節の出来事との時間関係を確認しましょう。');
 if(/\b(?:had|has|have)\s+(?:already\s+|never\s+|just\s+)?(?:[a-z]+ed|been|done|gone|seen|stood|known|written|made|taken|given|found|grown|heard|said|thought|spoken|broken|come|become|felt|left|had)\b/i.test(src))tips.push('have / has / had + 過去分詞：完了形の可能性があります。had の場合は過去完了を確認しましょう。');
 if(/\b(?:is|are|was|were|be|been|being)\s+(?:[a-z]+ly\s+)?(?:[a-z]+ed|given|known|seen|made|taken|written|heard|found|built|spoken)\b/i.test(src))tips.push('be動詞 + 過去分詞：受動態の可能性があります（形容詞的用法との区別に注意）。');
 if(/\b(?:who|whom|whose|which|that)\b/i.test(src))tips.push('who / which / that 等：関係詞か接続詞かを判断し、直前の名詞や後続の節を確認しましょう。');
 if(/\bto\s+[a-z]+\b/i.test(src))tips.push('to + 動詞：不定詞の可能性があります。目的・名詞的用法・形容詞的用法を文脈で確認します。');
 if(/\b(?:more|less)\s+[a-z]+\s+than\b|\b(?:better|worse)\s+than\b/i.test(src))tips.push('比較表現：than の前後で何を比較しているか確かめましょう。');
 if(/\bnot only\b|\bas well as\b|\bboth\b.*\band\b/i.test(src))tips.push('並列・対比の表現：並んでいる要素を探しましょう。');
 if(/\bthere\s+(?:is|are|was|were)\b/i.test(src))tips.push('there + be動詞：存在文の可能性があります。後ろの名詞句に注目しましょう。');
 if(/\b(?:may|might|could|would|should|must|can)\s+(?:have\s+)?[a-z]+\b/i.test(src))tips.push('助動詞：確実性・可能性・義務・推量などを表します。前後の文脈で意味が決まります。');
 if(!tips.length)tips.push('最初に主節の主語と動詞を探し、前置詞句や従属節がどこにかかるか確認しましょう。');
 return tips.join('\n\n');
}
function splitSentences(paragraph){return paragraph.match(/[^.!?]+(?:[.!?]+["'”’]?|$)/g)?.map(s=>s.trim()).filter(Boolean)||[paragraph];}
function tokenize(text,idx){return tokenizeWithMarkers(text,idx);}
// Offline *gloss* guide, not a machine translation. Never manufacture a full Japanese sentence.
function readingGlossary(text){
 const tokens=(String(text||'').match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)||[]).slice(0,100);
 const entries=[];let known=0;
 const maxPhraseWords=6;
 let i=0;for(;i<tokens.length&&entries.length<42;){
  let phrase=null;
  for(let n=Math.min(maxPhraseWords,tokens.length-i);n>=2;n--){
   const candidate=tokens.slice(i,i+n).join(' ').toLowerCase();
   const entry=getPhraseEntry(candidate);
   if(entry){phrase={text:tokens.slice(i,i+n).join(' '),entry};i+=n;break;}
  }
  if(phrase){entries.push(phrase);known++;continue;}
  const word=tokens[i++],entry=getWordEntry(word);if(entry)known++;entries.push({text:word,entry});
 }
 return {entries,known,total:entries.length,truncated:i<tokens.length};
}
function renderOfflineGloss(text){
 const guide=readingGlossary(text);
 return `<div class="offline-guide"><div class="offline-guide-header"><strong>語句ごとの読み解きガイド</strong><span>${guide.known}/${guide.total} 語句に語義あり</span></div><p class="small muted">語順に沿って単語・熟語の意味を示します。文章全体を自然な日本語に翻訳したものではありません。辞書の語義は文脈に合わない場合があります。</p><div class="offline-gloss-list">${guide.entries.map(({text,entry})=>`<div class="offline-gloss ${entry?'':'unknown'}"><strong>${E(text)}</strong><span>${E(entry?.ja||'未収録')}</span></div>`).join('')}</div>${guide.truncated?'<p class="small muted">長い文章は冒頭部分のみ表示しています。</p>':''}</div>`;
}
function renderOfflineGrammar(text){
 const chunks=String(text||'').split(/\b(although|because|since|when|while|if|unless|even though|whereas|who|which|that|where|before|after)\b/gi).filter(Boolean);
 const visual=chunks.length>1?`<div class="grammar-chunks">${chunks.slice(0,13).map((x,i)=>`<span class="${i%2?'grammar-signal':'grammar-chunk'}">${E(x.trim())}</span>`).join('')}</div><p class="small muted">区切りは接続語などを手掛かりにした候補です。正確な節・修飾範囲の判定ではありません。</p>`:'';
 return `${visual}<div class="note-box grammar-guide">${E(getGrammarTips(text))}</div><p class="small muted">簡易的な規則に基づく学習ヒントです。文脈により例外があります。SVOCを自動確定するものではありません。</p>`;
}
function openGlossEditor(){
 if(!panelSelection||readerMode!=='study')return;
 const key=normalizedDictKey(panelSelection.text).replace(/^[^a-z]+|[^a-z]+$/g,'');
 if(!key||key.length>120||key.split(' ').length>8){notify('8語以内の単語・熟語を選択してください');return;}
 const existing=db.userGloss?.[key],base=getWordEntry(key);
 closeModal();const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';bg.dataset.glossKey=key;
 bg.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><header class="modal-top"><h2 id="modalTitle">自分の英和辞書に登録</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body"><div class="field"><label>英語の語句</label><input value="${E(panelSelection.text)}" readonly></div><div class="field"><label for="glossJa">日本語の意味</label><textarea id="glossJa" rows="3" maxlength="500" placeholder="例：近づくのをためらう">${E(existing?.ja||base?.ja||'')}</textarea></div><div class="field"><label for="glossMemo">メモ（任意）</label><textarea id="glossMemo" rows="2" maxlength="500" placeholder="文脈や用法">${E(existing?.memo||'')}</textarea></div><div class="callout">登録した意味は内蔵辞書より優先され、バックアップ・手動同期にも含まれます。文脈により別の意味になる場合があります。</div></div><footer class="modal-actions"><button class="btn" data-act="close-modal">キャンセル</button>${existing?'<button class="btn danger" data-act="delete-gloss">削除</button>':''}<button class="btn primary" data-act="save-gloss">語義を保存</button></footer></section>`;
 document.body.appendChild(bg);$('#glossJa')?.focus();
}
function saveGloss(){const key=$('#modal')?.dataset.glossKey,ja=$('#glossJa')?.value.trim(),memo=$('#glossMemo')?.value.trim()||'';
 if(!key||!ja){notify('日本語の意味を入力してください');return;}
 db.userGloss||={};db.userGloss[key]={ja,memo,updatedAt:new Date().toISOString()};persist();closeModal();refreshArticlePreservingScroll();renderInsightPanel();notify('個人用英和辞書に保存しました');
}
function deleteGloss(){const key=$('#modal')?.dataset.glossKey;if(!key)return;delete db.userGloss[key];persist();closeModal();refreshArticlePreservingScroll();renderInsightPanel();notify('個人用英和辞書から削除しました');}
function renderArticle(m){
 let idx=0;
 return m.text.trim().split(/\n\s*\n/).map(par=>`<div class="article-paragraph">${splitSentences(par.trim()).map(sentence=>{
  const n=idx++;const translate=sentenceTranslation(n);const hasMark=markersFor(n).length>0;
  return `<div class="sentence-unit"><div class="sentence-line"><span class="sentence ${hasMark?'has-mark':''}" data-sentence="${n}" tabindex="0" title="一文の解説を表示">${tokenize(sentence,n)}</span>${readerMode==='study'?`<button class="sentence-more" data-act="select-sentence" data-index="${n}" title="この文の和訳・構文解説">${ico('help',12)}</button><button class="sentence-syntax" data-act="syntax-editor" data-index="${n}" title="この文のS/V/O/C/Mラベルを管理" aria-label="この文の構文ラベルを管理">構文</button>`:''}</div>${readerMode==='study'&&db.settings.parallelTranslation?`<div class="inline-translation"><span>${translate?E(translate):'<em>この文の和訳は未登録です</em>'}</span><button class="inline-edit" data-act="edit-sentence" data-index="${n}">${translate?'編集':'和訳を入力'}</button></div>`:''}</div>`;
 }).join('')}</div>`).join('');
}
function renderReader(){const m=getM(currentId);if(!m)return '<div class="page-wrap">教材が見つかりません。</div>';const p=getP(currentId);return `<div class="reader-page ${db.settings.focusMode?'focus-mode':''}"><div class="reader-top"><div class="button-row"><button class="btn icon-only ghost" data-act="nav" data-view="library" title="教材ライブラリに戻る">${ico('back')}</button><div><div class="reader-title">${E(m.title)}</div><div class="reader-metadata">${E(m.category)} · ${E(m.level)} · ${W(m.text).toLocaleString()} words</div></div></div><div class="reader-modes"><button class="reader-mode ${readerMode==='study'?'active':''}" data-act="reader-mode" data-mode="study">精読モード</button><button class="reader-mode ${readerMode==='exam'?'active':''}" data-act="reader-mode" data-mode="exam">演習モード</button></div></div><div class="reader-toolbar"><div class="toolbar-group"><span class="small muted">${ico('clock',14)} <span id="elapsedTime">${formatTime(sessionSeconds)}</span>${readerMode==='exam'?'<span class="timing-pill">WPM計測中</span>':''}</span><span class="toolbar-divider"></span><span class="small muted">進捗 <strong id="readingPercent">${p.percent}%</strong></span></div><div class="toolbar-group"><button class="btn sm" data-act="font-minus" title="文字を小さく">A−</button><button class="btn sm" data-act="font-plus" title="文字を大きく">A＋</button><label class="reader-tool-label">行間 <select id="readerLineHeight" aria-label="行間を選ぶ"><option value="1.65" ${db.settings.readerLineHeight===1.65?'selected':''}>狭い</option><option value="2.05" ${db.settings.readerLineHeight===2.05?'selected':''}>標準</option><option value="2.4" ${db.settings.readerLineHeight===2.4?'selected':''}>広い</option></select></label><label class="reader-tool-label">幅 <select id="readerWidth" aria-label="本文の幅"><option value="standard" ${db.settings.readerWidth!=='wide'?'selected':''}>標準</option><option value="wide" ${db.settings.readerWidth==='wide'?'selected':''}>広い</option></select></label><label class="reader-tool-label">書体 <select id="readerFont" aria-label="本文の書体"><option value="serif" ${db.settings.readerFont!=='sans'?'selected':''}>セリフ</option><option value="sans" ${db.settings.readerFont==='sans'?'selected':''}>ゴシック</option></select></label><button class="btn sm ${db.settings.focusMode?'soft':''}" data-act="reader-focus" title="解説パネルを隠して本文に集中">${ico('eye',14)} ${db.settings.focusMode?'集中を解除':'集中表示'}</button>${readerMode==='study'?`<button class="btn sm ${db.settings.parallelTranslation?'soft':''}" data-act="parallel-translation" title="英文の下に日本語訳を表示">${ico('layers',14)} 対訳 ${db.settings.parallelTranslation?'ON':'OFF'}</button><button class="btn sm ${db.settings.syntaxEnabled?'soft':''}" data-act="syntax-toggle" title="英文の主語・動詞・目的語などを色分け">${ico('layers',14)} 構文色分け ${db.settings.syntaxEnabled?'ON':'OFF'}</button><button class="btn sm" data-act="markers-list" title="マーカー一覧">${ico('marker',14)} マーカー ${markCount()}</button><button class="btn sm" data-act="speak">${ico('sound',14)} 読み上げ</button>`:''}<button class="btn sm" data-act="dark" title="テーマの切り替え">${ico(db.settings.dark?'moon':'sun',14)}</button></div></div><div class="reader-columns"><div class="card reading-card"><div class="article-instruction">${readerMode==='study'?'単語・熟語のクリック、英文のドラッグ選択に対応。範囲選択後は解説パネルからS/V/O/C/Mラベルを付けられます。<span class="syntax-disclaimer">※例文のほか手動ラベル・AI解析結果にも対応。AI解析にはサーバー設定が必要です。</span>':'演習中は構文色分け・辞書・解説を表示しません。読み終えてから採点してください。'}</div>${readerMode==='study'&&db.settings.syntaxEnabled?`<div class="syntax-legend" aria-label="構文の凡例">${rolePills()}<span class="tiny muted">色分けは例文・手動ラベル・AI解析結果です。AIの解析結果は要確認。</span></div>`:''}<div class="reader-scroll" id="readingScroll"><article class="article-content" id="readerArticle" style="--reading-size:${db.settings.fontSize}px;--reading-line:${db.settings.readerLineHeight||2.05};--reading-width:${db.settings.readerWidth==='wide'?'880px':'680px'}" class="reader-text-${db.settings.readerFont==='sans'?'sans':'serif'}">${renderArticle(m)}</article></div><div class="reading-footer"><div class="reader-info">${ico('book',15)} <span><strong>${W(m.text).toLocaleString()}</strong> words</span></div><div class="button-row"><button class="btn sm" data-act="complete">${ico('check',14)} 読了にする</button><button class="btn sm primary" data-act="start-quiz">理解度テスト ${ico('arrow',13)}</button></div></div></div><section class="card panel-card" id="insightPanel" aria-label="単語と文章の解説"><div class="panel-head"><h3>${ico('sparkles',17)} リーディングアシスト</h3><button class="btn sm ghost hidden" id="closePanel" data-act="close-panel" aria-label="解説を閉じる">${ico('close',16)}</button></div><div class="panel-body" id="panelBody"></div><div class="panel-footer" id="panelFooter"><span class="tiny muted">選択した単語や英文の解説がここに表示されます。</span></div></section></div></div>`;}
function renderPage(){const el=$('#page');if(!el)return;let html={home:renderHome,library:renderLibrary,review:renderReview,stats:renderStats,settings:renderSettings,reader:renderReader,quiz:renderQuiz,quizSetup:renderQuizSetup}[currentView];el.innerHTML=html?html():renderHome();if(currentView==='library')renderLibraryCards();if(currentView==='settings')updateSnapshotList();if(currentView==='reader'){const sc=$('#readingScroll');sc.scrollTop=getP(currentId).lastPosition||0;sc.addEventListener('scroll',onReaderScroll,{passive:true});if(readerMode==='exam'&&sc.scrollHeight<=sc.clientHeight+35)examReadFinished=true;renderInsightPanel();applyReaderAppearance();}document.body.classList.toggle('dark',db.settings.dark);}
let scrollSaveAt=0;
function onReaderScroll(){if(!currentId)return;const box=$('#readingScroll');if(!box)return;const p=getP(currentId),max=box.scrollHeight-box.clientHeight;p.lastPosition=box.scrollTop;if(readerMode==='exam'&&box.scrollTop>=max-35)examReadFinished=true;const percent=max>0?Math.min(99,Math.max(0,Math.round(box.scrollTop/max*100))):99;p.percent=Math.max(p.percent,percent);const label=$('#readingPercent');if(label)label.textContent=`${p.percent}%`;if(Date.now()-scrollSaveAt>1100){persist();scrollSaveAt=Date.now();}}
function sentenceFor(node){let el=node?.nodeType===1?node:node?.parentElement;let sentence=el?.closest('.sentence');return sentence?.textContent?.trim()||'';}
function getSelectionInArticle(){const sel=window.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount)return null;const text=sel.toString().trim();if(!text||text.length>1600)return null;const r=sel.getRangeAt(0);let container=r.commonAncestorContainer,element=container.nodeType===1?container:container.parentElement;if(!element||!$('#readerArticle')?.contains(element))return null;const sentence=sentenceFor(r.startContainer);const startEl=(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement)?.closest('.sentence');
 const endEl=(r.endContainer.nodeType===1?r.endContainer:r.endContainer.parentElement)?.closest('.sentence');
 const sentenceIndex=startEl&&startEl===endEl?Number(startEl.dataset.sentence):null;
 let start=null,end=null;
 if(Number.isInteger(sentenceIndex)){
  try{start=sentenceOffsetFromRange(r,startEl,r.startContainer,r.startOffset);end=sentenceOffsetFromRange(r,startEl,r.endContainer,r.endOffset);}catch{}
 }
 return {text,context:sentence,sentenceIndex,start,end};}
function onTextSelection(){if(currentView!=='reader'||readerMode==='exam')return;const hit=getSelectionInArticle();if(!hit)return;const old=panelSelection;selectedRange=hit.text;selectedContext=hit.context;panelSelection={...hit,kind:hit.text.split(/\s+/).length===1&&/^[A-Za-z'-]+$/.test(hit.text)?'word':hit.text.split(/\s+/).length>11?'sentence':'phrase'};panelTab=panelSelection.kind==='word'?'meaning':'translate';panelMessage=null;if(old?.text!==hit.text)activeLookup=null;renderInsightPanel();showFloatingToolbar();if(panelSelection.kind==='word')loadDictionary(hit.text);}
function showFloatingToolbar(){const selection=window.getSelection();if(!selection?.rangeCount)return;const rect=selection.getRangeAt(0).getBoundingClientRect();if(!rect.width&&!rect.height)return;let bar=$('#selectionToolbar');if(!bar){bar=document.createElement('div');bar.id='selectionToolbar';bar.className='floating-toolbar';document.body.appendChild(bar);}bar.innerHTML='<button data-act="panel-tab" data-tab="translate">和訳</button><button data-act="panel-tab" data-tab="grammar">構文</button><button data-act="add-marker" data-color="yellow">マーカー</button><button data-act="save-selection">保存</button>';if(window.matchMedia('(max-width:790px)').matches){bar.style.left='12px';bar.style.right='12px';bar.style.top='auto';bar.style.bottom='calc(68px + env(safe-area-inset-bottom,0px) + 10px)';}else{bar.style.left=`${Math.max(10,Math.min(window.innerWidth-265,rect.left+rect.width/2-130))}px`;bar.style.right='auto';bar.style.bottom='auto';bar.style.top=`${Math.max(9,rect.top-49)}px`;}bar.classList.remove('hidden');}
function removeFloatingToolbar(){const el=$('#selectionToolbar');if(el)el.remove();}
function selectWord(text,context,el,kind='word'){
 if(readerMode==='exam')return;
 document.querySelectorAll('.word.is-selected,.phrase.is-selected').forEach(x=>x.classList.remove('is-selected'));
 el?.classList.add('is-selected');
 const parent=el?.closest('.sentence'),idx=parent?Number(parent.dataset.sentence):null;
 let start=null,end=null;
 if(parent&&el){try{const range=document.createRange();range.selectNodeContents(parent);range.setEndBefore(el);start=range.toString().length;end=start+el.textContent.length;}catch{}}
 panelSelection={text,kind,context,sentenceIndex:idx,start,end};panelTab='meaning';panelMessage=null;activeLookup=null;removeFloatingToolbar();renderInsightPanel();if(kind==='word')loadDictionary(text);}
function getBuiltinExplanation(text,tab){if(tab==='meaning')return null;const clean=text.trim().replace(/\s+/g,' ');const match=SAMPLE_EXPLANATIONS[clean];if(match)return match[tab]||null;return null;}
function getWordEntry(w){const key=normalizedDictKey(w);const personal=db.userGloss?.[key];if(personal)return {ja:personal.ja,headword:key,source:'自分で登録した語義',usage:personal.memo||''};return getPhraseEntry(key)||BUILTIN[key]||BUILTIN[key.replace(/['’]s$/,'')]||offlineEntry(key)||null;}
function renderInsightPanel(){if(panelSelection&&db.settings.focusMode){db.settings.focusMode=false;persist();document.querySelector('.reader-page')?.classList.remove('focus-mode');const b=$('[data-act="reader-focus"]');if(b){b.classList.remove('soft');b.innerHTML=ico('eye',14)+' 集中表示';}}const panel=$('#insightPanel'),body=$('#panelBody'),footer=$('#panelFooter'),close=$('#closePanel');if(!body)return;panel.classList.toggle('active',!!panelSelection);close.classList.toggle('hidden',!panelSelection);if(!panelSelection){body.innerHTML=`<div class="panel-empty"><div class="panel-empty-icon">${ico('book',27)}</div><h3>英文を選択してみよう</h3><p>単語をクリックすると辞書を表示。複数語を選択すると和訳や文法解説を確認できます。</p></div>`;footer.innerHTML='<span class="tiny muted">英語を読みながら、必要なところだけ調べられます。</span>';return;}
 const s=panelSelection,kind=s.kind;const tabs=kind==='word'?[['meaning','辞書'],['translate','和訳'],['grammar','文法']]:[['translate','和訳'],['grammar','構文'],['meaning','ポイント']];
 let content='';const built=(Number.isInteger(s.sentenceIndex)?(panelTab==='translate'?sentenceTranslation(s.sentenceIndex):panelTab==='grammar'?sentenceGrammar(s.sentenceIndex):null):null)||getBuiltinExplanation(s.text,panelTab),entry=getWordEntry(s.text),dict=activeLookup?.word===s.text.toLowerCase()?activeLookup:null;
 if(panelMessage?.tab===panelTab&&panelMessage?.text===s.text){content=`<div class="note-box">${E(panelMessage.content)}</div>`;}
 else if(panelTab==='meaning'&&kind==='word'){
  if(entry){content=`${entry.headword&&entry.headword!==normalizedDictKey(s.text)?`<p class="small muted">見出し語：${E(entry.headword)}</p>`:''}<div class="meaning-main">${E(entry.ja)}</div><p class="small muted">${E(entry.pos||entry.source||'内蔵英和辞書')}</p>${entry.usage?`<div class="note-box">${E(entry.usage)}${entry.example?'\n'+E(entry.example):''}</div>`:''}<p class="small muted">辞書の一般的な語義です。文脈に応じた訳とは異なる場合があります。</p>`;}
  else if(dict){content=`${dict.phonetic?`<div class="small muted">${E(dict.phonetic)}</div>`:''}${dict.matched&&dict.matched!==dict.word?`<div class="small muted">原形「${E(dict.matched)}」で検索しました。</div>`:''}<div class="meaning-main" style="font-size:13px">${E(dict.definition||'英英辞書に見出し語が見つかりませんでした。')}</div><p class="small muted">${dict.error?'オフライン英和辞書にない単語です。追加辞書の取り込み、または外部翻訳を試してください。':'無料のオンライン英英辞書による説明です。日本語の意味は下の外部翻訳でも確認できます。'}</p>`;}
  else content='<div class="note-box">英和辞書に未収録です。オンライン英英辞書を検索しています…</div>';
 }else if(built){content=`<div class="note-box">${E(built)}</div><div class="small muted" style="margin-top:8px">内蔵サンプル解説</div>`;}
 else if(entry&&panelTab==='translate'){content=`<div class="meaning-main">${E(entry.ja)}</div><p class="small muted">${E(entry.source||'内蔵英和辞書')}の語義です。全文の自然な和訳にはAIなどが必要です。</p>`;}
 else if(panelTab==='meaning'&&kind!=='word'){content=entry?`<div class="meaning-main">${E(entry.ja)}</div><p class="small muted">${E(entry.source||'内蔵英和辞書')}</p>`:'<div class="note-box">辞書未収録の表現です。AI解説、または外部翻訳を利用できます。</div>';}
 else if(panelTab==='grammar'){content=renderOfflineGrammar(s.text);}
 else content=panelTab==='translate'?`<div class="note-box">この英文の自然な和訳は未登録です。下の語句ガイドを使って読み解いたり、自分の和訳を保存できます。</div>${renderOfflineGloss(s.text)}`:`<div class="note-box">選択した語句の解説は未登録です。</div>${renderOfflineGloss(s.text)}`;
 const freeTranslateUrl='https://translate.google.com/?sl=en&tl=ja&text='+encodeURIComponent(s.text)+'&op=translate';
 body.innerHTML=`<div class="selection-label">${kind==='word'?'SELECTED WORD':kind==='phrase'?'SELECTED PHRASE':'SELECTED SENTENCE'}</div><div class="selected-text">${E(s.text)}</div>${kind==='word'?'<div class="small muted">単語の意味・用法・文脈を調べられます。</div>':''}<div class="tabs">${tabs.map(([t,label])=>`<button class="tab ${panelTab===t?'active':''}" data-act="panel-tab" data-tab="${t}">${label}</button>`).join('')}</div><div id="panelContent">${content}</div><div class="panel-actions">${Number.isInteger(s.sentenceIndex)?`<button class="btn sm" data-act="edit-sentence" data-index="${s.sentenceIndex}">${ico('edit',14)} 和訳・構文メモを編集</button>`:''}${s.text.length<=120&&s.text.split(/\s+/).length<=8?`<button class="btn sm" data-act="edit-gloss">${ico('edit',14)} 語義を登録・修正</button>`:''}<button class="btn sm soft" data-act="ask-ai">${ico('sparkles',14)} AIで${panelTab==='grammar'?'構文解説':panelTab==='translate'?'翻訳':'詳しく解説'}</button>${kind==='word'?`<button class="btn sm" data-act="speak-selected">${ico('sound',14)} 発音</button>`:''}<a class="btn sm" href="${E(freeTranslateUrl)}" target="_blank" rel="noopener noreferrer">外部で英和を見る ↗</a></div>${Number.isInteger(s.sentenceIndex)?`<div class="syntax-panel-control"><div class="small muted">構文を色分け（英文の選択範囲を指定）：</div><div class="syntax-role-actions">${Object.entries(SYNTAX_ROLES).map(([role,info])=>`<button class="syntax-role-btn syntax-legend-${role.toLowerCase()}" data-act="syntax-tag" data-role="${role}" title="選択範囲を${info.name}にする">${role} <span>${E(info.name)}</span></button>`).join('')}</div><div class="button-row"><button class="btn sm" data-act="syntax-editor" data-index="${s.sentenceIndex}">この文のラベルを管理</button><button class="btn sm soft" data-act="syntax-ai" data-index="${s.sentenceIndex}" ${syntaxAiBusy?'disabled':''}>${ico('sparkles',14)} AIで構文解析</button></div>${syntaxInfo(s.sentenceIndex).mode==='ai'?'<p class="small muted">AIラベルを表示中。節の説明は「この文のラベルを管理」から確認できます。</p>':''}</div>`:''}${Number.isInteger(s.sentenceIndex)?`<div class="marker-control"><span class="small muted">マーカー：</span>${[['yellow','黄'],['green','緑'],['pink','桃']].map(([c,l])=>`<button class="marker-choice ${c}" data-act="add-marker" data-color="${c}" title="${l}でマーク" aria-label="${l}色のマーカー"></button>`).join('')}</div>`:''}<div class="small muted" style="margin-top:8px">内蔵英和辞書は通信・APIキー不要。「外部で英和を見る」は選択テキストをGoogle 翻訳へ送ります。</div>`;
 const found=db.saved.some(x=>x.materialId===currentId&&x.text===s.text);footer.innerHTML=`<button class="btn ${found?'soft':'primary'} full" data-act="save-selection">${ico(found?'check':'bookmark')} ${found?'復習リストに保存済み':'復習リストに保存'}</button>`;
}
// No paid service is needed for the public English dictionary. 404 and network errors
// are handled separately; inflected forms are retried as their likely headwords.
const DICT_CACHE=new Map();
const IRREGULAR_FORMS={
 was:'be',were:'be',been:'be',am:'be',is:'be',are:'be',had:'have',has:'have',did:'do',done:'do',
 went:'go',gone:'go',saw:'see',seen:'see',came:'come',ran:'run',took:'take',taken:'take',
 made:'make',got:'get',gotten:'get',wrote:'write',written:'write',knew:'know',known:'know',
 gave:'give',given:'give',found:'find',thought:'think',bought:'buy',brought:'bring',
 taught:'teach',caught:'catch',felt:'feel',left:'leave',kept:'keep',slept:'sleep',
 spoke:'speak',spoken:'speak',ate:'eat',eaten:'eat',drank:'drink',drunk:'drink',
 broke:'break',broken:'break',chose:'choose',chosen:'choose',fell:'fall',fallen:'fall',
 grew:'grow',grown:'grow',flew:'fly',flown:'fly',drove:'drive',driven:'drive',
 held:'hold',heard:'hear',lost:'lose',paid:'pay',said:'say',sold:'sell',sent:'send',
 sat:'sit',stood:'stand',understood:'understand',won:'win',wore:'wear',worn:'wear',
 men:'man',women:'woman',children:'child',feet:'foot',teeth:'tooth',mice:'mouse',geese:'goose',
 people:'person',better:'good',best:'good',worse:'bad',worst:'bad'
};
function dictionaryCandidates(word){
 const base=normalizedDictKey(word).replace(/^[^a-z]+|[^a-z]+$/g,'');
 const list=[base];const add=w=>{if(w&&w.length>=2&&!list.includes(w))list.push(w);};
 if(IRREGULAR_FORMS[base])add(IRREGULAR_FORMS[base]);
 if(/['’]s$/.test(base))add(base.slice(0,-2));
 if(/['’](?:ve|re|ll|d|m)$/.test(base))add(base.replace(/['’](?:ve|re|ll|d|m)$/,''));
 if(/n't$/.test(base))add(base.slice(0,-3));
 if(base.endsWith('ies')&&base.length>4)add(base.slice(0,-3)+'y');
 if(base.endsWith('ves')&&base.length>4){add(base.slice(0,-3)+'f');add(base.slice(0,-3)+'fe');}
 if(base.endsWith('es')&&base.length>3){add(base.slice(0,-2));add(base.slice(0,-1));}
 else if(base.endsWith('s')&&base.length>3)add(base.slice(0,-1));
 if(base.endsWith('ied')&&base.length>4)add(base.slice(0,-3)+'y');
 if(base.endsWith('ed')&&base.length>4){add(base.slice(0,-2));add(base.slice(0,-1));}
 if(base.endsWith('ing')&&base.length>5){const stem=base.slice(0,-3);add(stem);if(stem.at(-1)===stem.at(-2))add(stem.slice(0,-1));add(stem+'e');}
 if(base.endsWith('ier')&&base.length>4)add(base.slice(0,-3)+'y');
 if(base.endsWith('iest')&&base.length>5)add(base.slice(0,-4)+'y');
 if(base.endsWith('est')&&base.length>5){add(base.slice(0,-3));add(base.slice(0,-2));}
 if(base.endsWith('er')&&base.length>4){add(base.slice(0,-2));add(base.slice(0,-1));}
 return list.slice(0,13);
}
async function loadDictionary(word){
 const entry=getWordEntry(word);if(entry)return;
 const key=word.toLowerCase().trim();
 const update=(data)=>{if(panelSelection?.kind==='word'&&panelSelection.text.toLowerCase().trim()===key){activeLookup={word:key,...data};if(panelTab==='meaning')renderInsightPanel();}};
 if(DICT_CACHE.has(key)){update(DICT_CACHE.get(key));return;}
 let data=null;
 try{
  for(const candidate of dictionaryCandidates(word)){
   const res=await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(candidate)}`,{signal:AbortSignal.timeout(7000)});
   if(res.status===404)continue;
   if(!res.ok)throw new Error(`HTTP ${res.status}`);
   const json=await res.json(),one=json?.[0],def=one?.meanings?.flatMap(m=>m.definitions||[]).find(d=>d.definition)?.definition;
   if(!def)continue;
   data={matched:candidate,phonetic:one?.phonetic||one?.phonetics?.find(x=>x.text)?.text||'',definition:def};break;
  }
  if(!data)data={error:'not_found',definition:'英英辞書に見出し語が見つかりませんでした。原形・つづりを確認してください。'};
 }catch(e){data={error:'network',definition:'英英辞書への接続に失敗しました。インターネット接続を確認し、時間をおいて再試行してください。'};}
 // Cache successful hits and genuine "not found" results; retry network failures next time.
 if(data.error!=='network')DICT_CACHE.set(key,data);
 update(data);
}
async function aiRequest(type,selection,question=''){if(STATIC_DEPLOY)throw Error('この公開用サイトにはAIサーバーがありません。AI機能はNodeサーバー版で利用できます。');let res;try{res=await fetch('/api/explain',{method:'POST',headers:{'Content-Type':'application/json',...(syncToken?{'Authorization':'Bearer '+syncToken}:{})},body:JSON.stringify({type,text:selection.text,context:selection.context,question}),signal:AbortSignal.timeout(55000)});}catch{throw Error('AIサーバーに接続できません。READMEの手順で起動してください。');}let json;try{json=await res.json();}catch{throw Error('サーバーから正常な応答がありませんでした。');}if(!res.ok)throw Error(json.error||'AIの処理でエラーが発生しました。');return json.result;}
async function askAI(){if(!panelSelection)return;const selection={...panelSelection};const tab=panelTab,type=tab==='translate'?'translate':tab==='grammar'?'grammar':'word';panelMessage={tab,text:selection.text,content:'AIに問い合わせています…'};renderInsightPanel();const btn=$('[data-act="ask-ai"]');if(btn)btn.disabled=true;try{const result=await aiRequest(type,selection);if(panelSelection?.text===selection.text){panelMessage={tab,text:selection.text,content:result};
 if(Number.isInteger(selection.sentenceIndex)&&selection.text===sentenceTextAt(selection.sentenceIndex)&&(tab==='translate'||tab==='grammar')){
  db.notes ||= {};db.notes[currentId] ||= {};
  const existing=getSentenceNote(selection.sentenceIndex)||{source:selection.text,translation:'',grammar:''};
  db.notes[currentId][String(selection.sentenceIndex)]={...existing,[tab==='translate'?'translation':'grammar']:result,updatedAt:new Date().toISOString()};
  persist();refreshArticlePreservingScroll();
 }
 renderInsightPanel();}}catch(e){if(panelSelection?.text===selection.text){panelMessage={tab,text:selection.text,content:e.message};renderInsightPanel();}}}
function saveSelection(){if(!panelSelection)return;const s=panelSelection;let existing=db.saved.find(x=>x.materialId===currentId&&x.text===s.text);if(existing){notify('すでに復習リストに保存されています');return;}const entry=getWordEntry(s.text);const note=entry?.ja||(Number.isInteger(s.sentenceIndex)?sentenceTranslation(s.sentenceIndex):'')||SAMPLE_EXPLANATIONS[s.text]?.translate||((panelMessage?.text===s.text&&panelTab==='translate')?panelMessage.content:'');db.saved.unshift({id:'b'+Date.now()+Math.floor(Math.random()*1000),kind:s.kind,text:s.text,context:s.context,materialId:currentId,folderId:autoFolderForMaterial(currentId),autoFolder:true,note,createdAt:new Date().toISOString()});persist();renderInsightPanel();notify('復習リストに保存しました');}
function markComplete(){if(!currentId)return;if(readerMode==='exam')examReadFinished=true;const p=getP(currentId);p.percent=100;p.finished=true;persist();notify('読了にしました。おつかれさま！');renderPage();}
function pronounce(text){if(!('speechSynthesis' in window)){notify('このブラウザは音声読み上げに対応していません');return;}stopSpeech();try{const utt=new SpeechSynthesisUtterance(text);utt.lang='en-US';utt.rate=db.settings.voiceRate;const eng=speechSynthesis.getVoices().find(v=>v.lang==='en-US')||speechSynthesis.getVoices().find(v=>v.lang.startsWith('en'));if(eng)utt.voice=eng;speechSynthesis.speak(utt);}catch{notify('読み上げを開始できませんでした');}}
// v0.2.0: test bank; quoted evidence is used only when it exists in the textbook.
const SAMPLE_QUESTION_META={
 'sample-house':[
  {type:'detail',evidence:'villagers were reluctant to approach it'},
  {type:'detail',evidence:'a small brass key lying on the steps'},
  {type:'inference',evidence:'a letter addressed to someone with her own name'}],
 'sample-trees':[
  {type:'detail',evidence:'a process called transpiration'},
  {type:'main',evidence:'Cities must choose suitable species'}],
 'sample-letter':[
  {type:'detail',evidence:'he worried about making mistakes'},
  {type:'inference',evidence:'Nobody laughed when Daniel made a mistake'}]
};
const QUIZ_TYPES={detail:'内容一致・情報検索',inference:'推論',main:'主題・要旨',vocab:'語彙・文脈'};
function normalizedQuestions(questions){return questions.filter(q=>q&&typeof q.q==='string'&&q.q.trim()&&Array.isArray(q.options)&&q.options.length===4&&q.options.every(o=>typeof o==='string'&&o.trim())&&Number.isInteger(q.answer)&&q.answer>=0&&q.answer<4).slice(0,15).map(q=>({q:q.q.trim().slice(0,500),options:q.options.map(o=>o.trim().slice(0,300)),answer:q.answer,why:String(q.why||'').trim().slice(0,1200),type:QUIZ_TYPES[q.type]?q.type:'detail',evidence:String(q.evidence||'').trim().slice(0,350)}));}
function getQuestionsFor(material){if(!material)return [];const custom=db.customQuizzes?.[material.id];if(custom?.sourceText===material.text&&Array.isArray(custom.questions))return normalizedQuestions(custom.questions);const original=SAMPLE_MATERIALS.find(m=>m.id===material.id);if(original?.text===material.text){return normalizedQuestions((SAMPLE_QUIZZES[material.id]||[]).map((q,i)=>({...q,...(SAMPLE_QUESTION_META[material.id]?.[i]||{})})));}return [];}
function locateEvidence(material,quote){if(!material||!quote)return -1;const needle=quote.trim().toLowerCase().replace(/\s+/g,' ');if(!needle)return -1;return getArticleSentences(material).findIndex(sentence=>sentence.toLowerCase().replace(/\s+/g,' ').includes(needle));}
function quizReadingWPM(seconds,material,finished){if(!finished||!Number.isFinite(seconds)||seconds<10||!material)return null;return Math.round(W(material.text)*60/seconds);}
function quizScore(quiz){return quiz.questions.reduce((sum,q,i)=>sum+(quiz.answers[i]===q.answer?1:0),0);}
function renderQuizSetup(){const m=getM(currentId);if(!m||!quizPending)return `<div class="page-wrap">教材が見つかりません。</div>`;const count=quizPending.questions.length;const wpm=quizReadingWPM(quizPending.readingSeconds,m,quizPending.readingComplete);return `<div class="page-wrap quiz-layout"><div class="page-head"><div><div class="eyebrow">READING LAB / EXAM PRACTICE</div><h1>読解テストの準備</h1><p>${E(m.title)} · ${W(m.text)} words</p></div><button class="btn" data-act="open" data-id="${E(m.id)}">本文へ戻る</button></div><div class="quiz-summary-grid"><div class="card quiz-metric"><span>収録問題数</span><strong>${count}<small> 問</small></strong></div><div class="card quiz-metric"><span>演習読書時間</span><strong>${Number.isFinite(quizPending.readingSeconds)?formatTime(quizPending.readingSeconds):'—'}</strong></div><div class="card quiz-metric"><span>読書速度</span><strong>${wpm??'—'}<small> ${wpm?'WPM':''}</small></strong></div></div><div class="card card-pad" style="margin-top:18px"><h2 class="card-title">テストの設定</h2><p class="small muted">時間はテスト開始から計測します。回答中に別タブへ移動すると時計は一時停止します。</p><div class="field" style="max-width:280px;margin:18px 0"><label for="quizLimit">制限時間</label><select id="quizLimit"><option value="0">無制限</option><option value="300">5分</option><option value="600">10分</option><option value="900">15分</option></select></div><div class="button-row"><button class="btn" data-act="edit-quiz">${ico('edit',15)} 問題を${count?'編集':'作成'}（無料）</button><button class="btn" data-act="ai-quiz">${ico('sparkles',15)} AIで問題を生成</button><button class="btn primary" data-act="begin-quiz" ${!count?'disabled':''}>${ico('arrow',15)} ${count}問でテスト開始</button></div>${!count?'<div class="callout" style="margin-top:17px">この教材には問題がまだありません。「問題を作成」から自分で設問を登録するか、AIサーバーを接続して自動生成してください。問題を本文からでっち上げることはありません。</div>':`<div class="callout" style="margin-top:17px">TOEIC風の四択形式。${[...new Set(quizPending.questions.map(q=>QUIZ_TYPES[q.type]))].join('・')}を出題します。公式TOEIC問題ではありません。</div>`}</div></div>`;}
function renderQuiz(){if(!activeQuiz)return `<div class="page-wrap"><button class="btn" data-act="nav" data-view="library">教材へ戻る</button></div>`;const quiz=activeQuiz,{questions,answers,showResult}=quiz;const material=getM(quiz.materialId),total=questions.length,answered=answers.filter(a=>a!==null).length,score=quizScore(quiz);const wpm=quizReadingWPM(quiz.readingSeconds,material,quiz.readingComplete);return `<div class="page-wrap quiz-layout"><div class="page-head"><div><div class="eyebrow">TOEIC-STYLE READING PRACTICE</div><h1>${showResult?'テスト結果':'理解度テスト'}</h1><p>${E(material?.title||'教材')} · ${answered}/${total} 問回答</p></div><button class="btn" data-act="open" data-id="${E(quiz.materialId)}">${ico('back')} 本文に戻る</button></div><div class="quiz-status-bar"><span>${ico('clock',15)} 解答時間 <strong id="quizElapsed">${formatTime(quiz.elapsed)}</strong></span><span>${quiz.timeLimitSeconds>0?'残り時間 <strong id="quizRemaining">'+formatTime(Math.max(0,quiz.timeLimitSeconds-quiz.elapsed))+'</strong>':'制限時間なし'}</span><span>${answered} / ${total} 問回答</span></div>${showResult?`<div class="card quiz-result"><div class="eyebrow">YOUR RESULT ${quiz.timedOut?'· 時間切れ':''}</div><div><strong>${Math.round(score/total*100)}%</strong></div><div class="semibold">${score} / ${total} 問正解</div><div class="quiz-summary-grid" style="margin-top:20px"><div><span>理解度</span><b>${Math.round(score/total*100)}%</b></div><div><span>読書速度</span><b>${wpm??'—'}${wpm?' WPM':''}</b></div><div><span>解答時間</span><b>${formatTime(quiz.elapsed)}</b></div></div><p class="small muted">間違えた問題は本文の根拠箇所へ戻って復習できます。WPMは演習モードで最後までスクロールし、10秒以上読んだ場合のみ表示されます。</p></div>`:`<div class="callout" style="margin:14px 0">本文の内容に基づいて解答してください。採点するまで正答・解説は表示されません。${quiz.timeLimitSeconds?'制限時間に達すると未回答を不正解として自動採点します。':''}</div>`}${questions.map((q,i)=>{const correct=answers[i]===q.answer;const evidenceIndex=locateEvidence(material,q.evidence);return `<div class="card quiz-card" id="question-${i}"><div class="quiz-question-top"><span class="overline">QUESTION ${String(i+1).padStart(2,'0')} / ${total}</span><span class="tag blue">${E(QUIZ_TYPES[q.type]||QUIZ_TYPES.detail)}</span></div><h3>${E(q.q)}</h3><div class="quiz-options">${q.options.map((o,j)=>`<button ${showResult?'disabled':''} class="quiz-option ${answers[i]===j?'chosen':''} ${showResult&&j===q.answer?'correct':''} ${showResult&&answers[i]===j&&j!==q.answer?'wrong':''}" data-act="answer" data-q="${i}" data-option="${j}">${String.fromCharCode(65+j)}. ${E(o)}</button>`).join('')}</div>${showResult?`<div class="note-box"><strong>${correct?'正解':'不正解'} ／ 正答 ${String.fromCharCode(65+q.answer)}</strong><p>${E(q.why||'この設問には解説が未登録です。')}</p>${q.evidence?`<div class="quiz-evidence">本文の根拠：<em>“${E(q.evidence)}”</em></div>`:''}${evidenceIndex>=0?`<button class="btn sm soft" data-act="jump-evidence" data-index="${evidenceIndex}" data-id="${E(quiz.materialId)}">${ico('book',14)} 根拠の英文を読む</button>`:''}</div>`:''}</div>`;}).join('')}<div class="button-row" style="justify-content:flex-end;margin:22px 0"><button class="btn" data-act="open" data-id="${E(quiz.materialId)}">本文に戻る</button>${showResult?`<button class="btn primary" data-act="reset-quiz">もう一度解く ${ico('rotate')}</button>`:`<button class="btn primary" data-act="submit-quiz" ${answered<total?'disabled title="全問回答してください"':''}>採点する ${ico('arrow')}</button>`}</div></div>`;}
function enterQuiz(){if(!quizPending?.questions?.length)return;const limit=Number($('#quizLimit')?.value)||0;const pending=quizPending;stopSession();currentView='quiz';activeQuiz={materialId:pending.materialId,questions:pending.questions.map(q=>({...q,options:[...q.options]})),answers:pending.questions.map(()=>null),showResult:false,elapsed:0,timeLimitSeconds:limit,readingSeconds:pending.readingSeconds,readingComplete:pending.readingComplete,startedAt:new Date().toISOString(),timedOut:false};renderPage();updateNav();window.scrollTo(0,0);}
function startQuiz(){const m=getM(currentId);if(!m){notify('教材が見つかりません');return;}quizPending={materialId:m.id,questions:getQuestionsFor(m),readingSeconds:readerMode==='exam'?sessionSeconds:null,readingComplete:readerMode==='exam'&&examReadFinished};stopSession();currentView='quizSetup';renderPage();updateNav();window.scrollTo(0,0);}
function submitQuiz(timedOut=false){if(!activeQuiz||activeQuiz.showResult)return;if(!timedOut&&activeQuiz.answers.some(x=>x===null)){notify('すべての問題に回答してください');return;}activeQuiz.timedOut=timedOut;activeQuiz.showResult=true;const score=quizScore(activeQuiz);const material=getM(activeQuiz.materialId);db.quizResults.push({id:'t'+Date.now(),materialId:activeQuiz.materialId,score,total:activeQuiz.questions.length,date:new Date().toISOString(),elapsedSeconds:activeQuiz.elapsed,readingSeconds:activeQuiz.readingSeconds,readingComplete:activeQuiz.readingComplete,wpm:quizReadingWPM(activeQuiz.readingSeconds,material,activeQuiz.readingComplete),timedOut,mode:Number.isFinite(activeQuiz.readingSeconds)?'exam':'study',answers:[...activeQuiz.answers],questions:activeQuiz.questions.map(q=>({...q,options:[...q.options]}))});persist();renderPage();window.scrollTo(0,0);if(timedOut)notify('制限時間になったため、自動採点しました。');}
async function generateQuizAI(){const m=getM(currentId);if(!m||quizLoading)return;quizLoading=true;notify('AIで問題を生成しています…');try{const output=await aiRequest('quiz',{text:m.text.slice(0,8000),context:''});const value=JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g,''));const list=Array.isArray(value)?value:value.questions;const clean=normalizedQuestions(Array.isArray(list)?list:[]);if(!clean.length)throw Error('有効な四択問題が生成されませんでした');quizPending.questions=clean;db.customQuizzes[m.id]={sourceText:m.text,questions:clean,updatedAt:new Date().toISOString()};persist();renderPage();notify(`${clean.length}問の問題を保存しました。設問は編集できます。`);}catch(e){notify(e.message||'AIで問題を生成できませんでした');}finally{quizLoading=false;}}
function renderQuizEditorItem(q={},i=0){const options=Array.isArray(q.options)?q.options:['','','',''];return `<div class="quiz-edit-item" data-edit-question="${i}"><div class="quiz-question-top"><b>問題 ${i+1}</b><button class="btn sm danger" data-act="delete-question" type="button">${ico('trash',13)} 削除</button></div><div class="field"><label>問題文（英語）</label><textarea class="question-text" rows="2" maxlength="500" placeholder="What is the main purpose of this passage?">${E(q.q||'')}</textarea></div><div class="quiz-option-edit">${options.map((text,index)=>`<div class="field"><label>選択肢 ${String.fromCharCode(65+index)}</label><input class="option-${index}" maxlength="300" value="${E(text||'')}"></div>`).join('')}</div><div class="field-grid"><div class="field"><label>正解</label><select class="question-answer">${[0,1,2,3].map(index=>`<option value="${index}" ${q.answer===index?'selected':''}>${String.fromCharCode(65+index)}</option>`).join('')}</select></div><div class="field"><label>問題の種類</label><select class="question-type">${Object.entries(QUIZ_TYPES).map(([k,v])=>`<option value="${k}" ${q.type===k?'selected':''}>${E(v)}</option>`).join('')}</select></div></div><div class="field"><label>解説（日本語）</label><textarea class="question-why" maxlength="1200" rows="2" placeholder="正解の理由や本文の手がかり">${E(q.why||'')}</textarea></div><div class="field"><label>根拠の英文（本文から短く引用・任意）</label><input class="question-evidence" maxlength="350" placeholder="本文の一部分をそのまま入力" value="${E(q.evidence||'')}"></div></div>`;}
function showQuizEditor(){const m=getM(currentId);if(!m)return;closeModal();const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';const q=quizPending?.questions?.length?quizPending.questions:[{}];bg.innerHTML=`<section class="modal quiz-editor-modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><header class="modal-top"><h2 id="modalTitle">読解問題を編集</h2><button class="btn icon-only ghost" data-act="close-modal">${ico('close')}</button></header><div class="modal-body"><p class="small muted">四択問題を1～15問登録できます。正答と解説も入力してください。根拠となる英文を入力すると、採点後に本文へ戻るボタンを表示します。</p><div id="quizEditorItems">${q.map((item,i)=>renderQuizEditorItem(item,i)).join('')}</div><button class="btn" data-act="add-question">${ico('plus',14)} 問題を追加</button></div><footer class="modal-actions"><button class="btn" data-act="close-modal">キャンセル</button><button class="btn primary" data-act="save-quiz-editor">問題を保存</button></footer></section>`;document.body.appendChild(bg);}
function addQuestionEditor(){const el=$('#quizEditorItems');if(!el)return;if(el.children.length>=15){notify('問題は最大15問です');return;}el.insertAdjacentHTML('beforeend',renderQuizEditorItem({},el.children.length));}
function saveQuizEditor(){const m=getM(currentId);if(!m)return;const blocks=[...document.querySelectorAll('[data-edit-question]')];if(!blocks.length){notify('少なくとも1問作成してください');return;}const questions=[];for(const [i,el] of blocks.entries()){const q={q:el.querySelector('.question-text').value.trim(),options:[0,1,2,3].map(n=>el.querySelector(`.option-${n}`).value.trim()),answer:Number(el.querySelector('.question-answer').value),type:el.querySelector('.question-type').value,why:el.querySelector('.question-why').value.trim(),evidence:el.querySelector('.question-evidence').value.trim()};if(!q.q||q.options.some(v=>!v)||!q.why){notify(`問題${i+1}：問題文・選択肢4つ・解説を入力してください`);return;}if(q.evidence&&locateEvidence(m,q.evidence)<0){notify(`問題${i+1}：根拠の英文が本文内に見つかりません。本文と同じ表記で入力してください`);return;}questions.push(q);}const clean=normalizedQuestions(questions);db.customQuizzes[m.id]={sourceText:m.text,questions:clean,updatedAt:new Date().toISOString()};quizPending.questions=clean;persist();closeModal();renderPage();notify(`${clean.length}問の問題を保存しました`);}
function jumpToEvidence(materialId,index){if(!getM(materialId))return;readerMode='study';go('reader',materialId);const el=$(`#readerArticle .sentence[data-sentence="${index}"]`);if(!el){notify('該当する英文を見つけられませんでした');return;}el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('evidence-focus');showSentence(index);setTimeout(()=>el.classList.remove('evidence-focus'),4500);}
const MATERIAL_CATEGORIES=['小説','科学・社会','ニュース','エッセイ','ビジネス','その他'];
const MATERIAL_LEVELS=['A1','A2','B1','B2','C1','C2','不明'];

// Reading Lab v0.5.0 — import of readable text from EPUB / PDF documents.
// EPUB processing is local/offline with bundled JSZip. No file data is uploaded.
// PDF.js is loaded from a pinned CDN when first needed; PDF import needs connectivity.
const IMPORT_MAX_BYTES=30*1024*1024;
const IMPORT_MAX_TEXT=120000;
const PDF_JS_VERSION='3.11.174';
const PDF_JS_URL=`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_JS_VERSION}/pdf.min.js`;
const PDF_WORKER_URL=`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_JS_VERSION}/pdf.worker.min.js`;
function normalizeArchivePath(path){
 const result=[];
 for(const part of String(path||'').replace(/\\/g,'/').split('/')){
  if(part===''||part==='.')continue;
  if(part==='..'){if(result.length)result.pop();else throw Error('EPUB内部のファイル位置が正しくありません');}
  else result.push(part);
 }
 return result.join('/');
}
function epubXml(source){
 const doc=new DOMParser().parseFromString(source,'application/xml');
 if(doc.querySelector('parsererror'))throw Error('EPUBのXMLデータを解釈できませんでした');
 return doc;
}
function xmlElements(node,name){return [...node.getElementsByTagName('*')].filter(e=>e.localName===name);}
function flattenXhtml(src){
 // Use XML/HTML parsing, never inject the book HTML into our app UI.
 let documentNode=new DOMParser().parseFromString(src,'application/xhtml+xml');
 if(documentNode.querySelector('parsererror'))documentNode=new DOMParser().parseFromString(src,'text/html');
 for(const el of [...documentNode.querySelectorAll('script,style,svg,nav,aside,head')])el.remove();
 const body=xmlElements(documentNode,'body')[0]||documentNode.body||documentNode.documentElement;
 const lineTags=new Set(['p','h1','h2','h3','h4','h5','h6','li','blockquote','dt','dd','pre']);
 const out=[];
 const walk=node=>{
  if(node.nodeType===3){const val=node.nodeValue?.replace(/\s+/g,' ')||'';if(val)out.push(val);return;}
  if(node.nodeType!==1)return;
  const tag=node.localName?.toLowerCase()||'';
  if(['script','style','svg','nav','aside'].includes(tag))return;
  if(['br','hr'].includes(tag)){out.push('\n');return;}
  const block=lineTags.has(tag);
  if(block)out.push('\n\n');
  for(const child of node.childNodes)walk(child);
  if(block)out.push('\n\n');
 };
 walk(body);
 return out.join('').replace(/[ \t]+/g,' ').replace(/[ \t]*\n[ \t]*/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
async function extractEpubSections(file){
 if(!window.JSZip)throw Error('EPUB解凍機能を読み込めませんでした');
 const archive=await JSZip.loadAsync(await file.arrayBuffer());
 const container=archive.file('META-INF/container.xml');
 if(!container)throw Error('EPUBのcontainer.xmlがありません');
 const metadata=epubXml(await container.async('string'));
 const root=xmlElements(metadata,'rootfile')[0];
 if(!root)throw Error('EPUBの本文ファイルが見つかりません');
 const opfPath=normalizeArchivePath(root.getAttribute('full-path'));
 const opfFile=archive.file(opfPath);
 if(!opfFile)throw Error('EPUBのOPFファイルを開けません');
 const opf=epubXml(await opfFile.async('string'));
 const title=xmlElements(opf,'title')[0]?.textContent?.trim()||file.name.replace(/\.epub$/i,'');
 const baseDir=opfPath.includes('/')?opfPath.slice(0,opfPath.lastIndexOf('/')+1):'';
 const items=new Map();
 for(const item of xmlElements(opf,'item'))items.set(item.getAttribute('id'),{href:item.getAttribute('href'),media:item.getAttribute('media-type'),properties:item.getAttribute('properties')||''});
 const spine=xmlElements(opf,'itemref');
 const sections=[];
 let total=0;
 for(const [index,reference] of spine.entries()){
  if(index>=200)break;
  const item=items.get(reference.getAttribute('idref'));
  if(!item||!item.media?.includes('xhtml')||!item.href)continue;
  const path=normalizeArchivePath(baseDir+decodeURIComponent(item.href.split('#')[0]));
  const zipped=archive.file(path);
  if(!zipped)continue;
  const source=await zipped.async('string');
  if(source.length>1_500_000)throw Error('1章の文章量が多すぎるため取り込みを中止しました');
  const text=flattenXhtml(source);
  total+=text.length;
  if(total>750_000)throw Error('EPUBが大きすぎます。章ごとに分けたファイルをお試しください');
  if(text.trim()){
   const doc=new DOMParser().parseFromString(source,'application/xhtml+xml');
   const heading=xmlElements(doc,'h1')[0]||xmlElements(doc,'h2')[0]||xmlElements(doc,'h3')[0];
   sections.push({label:(heading?.textContent||`第${sections.length+1}章`).trim().slice(0,68),text});
  }
 }
 if(!sections.length)throw Error('EPUBに読み取り可能な文章がありません');
 return {kind:'EPUB',title,sections};
}
async function getPDFJS(){
 if(window.pdfjsLib)return window.pdfjsLib;
 if(!pdfScriptPromise){
  pdfScriptPromise=new Promise((resolve,reject)=>{
   const tag=document.createElement('script');tag.src=PDF_JS_URL;tag.async=true;
   let settled=false;
   const timer=setTimeout(()=>finish(Error('PDFの解析ライブラリが応答しません。ネット接続を確認してください。')),10000);
   function finish(error){if(settled)return;settled=true;clearTimeout(timer);if(error){tag.remove();reject(error);}else resolve(window.pdfjsLib);}
   tag.onload=()=>finish(window.pdfjsLib?null:Error('PDF読み込みライブラリを利用できません'));
   tag.onerror=()=>finish(Error('PDFの解析にはインターネット接続が必要です（PDF.jsの読み込みに失敗）'));
   document.head.appendChild(tag);
  }).catch(e=>{pdfScriptPromise=null;throw e;});
 }
 const pdfjs=await pdfScriptPromise;
 pdfjs.GlobalWorkerOptions.workerSrc=PDF_WORKER_URL;
 return pdfjs;
}
function extractPdfPageText(content){
 const result=[];
 let lastY=null,prev=null;
 for(const item of content.items||[]){
  if(!item.str)continue;
  const y=item.transform?.[5];
  if(lastY!==null&&Number.isFinite(y)&&Math.abs(lastY-y)>3)result.push('\n');
  else if(prev&&/[A-Za-z0-9,.;:!?)]$/.test(prev)&&/^[A-Za-z0-9(]/.test(item.str))result.push(' ');
  result.push(item.str);
  if(item.hasEOL)result.push('\n');
  if(Number.isFinite(y))lastY=y;
  prev=item.str;
 }
 return result.join('').replace(/[ \t]+/g,' ').replace(/[ \t]*\n[ \t]*/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
async function extractPdfSections(file){
 const pdfjs=await getPDFJS();
 let documentHandle;
 try{
  const task=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false});
  documentHandle=await task.promise;
  if(documentHandle.numPages>200)throw Error('PDFは200ページ以内にしてください。必要な章を別ファイルに分けてください');
  const sections=[];
  let total=0;
  for(let n=1;n<=documentHandle.numPages;n++){
   const page=await documentHandle.getPage(n);
   const words=await page.getTextContent();
   const text=extractPdfPageText(words);
   if(text){total+=text.length;if(total>750_000)throw Error('PDFの抽出文字数が多すぎます。必要なページを別PDFにしてください');sections.push({label:`${n}ページ`,text});}
  }
  if(!sections.length)throw Error('テキストを抽出できませんでした。画像・スキャンPDFはOCRが必要です');
  return {kind:'PDF',title:file.name.replace(/\.pdf$/i,''),sections};
 }finally{try{await documentHandle?.destroy();}catch{}}
}
function importRangeChange(){
 if(!importedSections)return;
 const from=Number($('#importStart')?.value||0),to=Number($('#importEnd')?.value||0);
 const status=$('#importRangeStatus'),body=$('#materialBody');
 if(from>to){if(status)status.textContent='開始位置は終了位置以前にしてください。';return;}
 const text=importedSections.sections.slice(from,to+1).map(x=>x.text).join('\n\n');
 if(status)status.textContent=`${to-from+1}章・ページ / ${W(text).toLocaleString()}語 / ${text.length.toLocaleString()}文字${text.length>IMPORT_MAX_TEXT?'（文字数上限を超えています。範囲を縮めてください）':''}`;
 if(body){body.value=text.slice(0,IMPORT_MAX_TEXT);const counter=$('#materialWords');if(counter)counter.textContent=W(body.value);}
}
function renderImportRange(){
 if(!importedSections)return;
 const elements=importedSections.sections;
 const el=$('#importSectionPreview');if(!el)return;
 const options=elements.map((x,i)=>`<option value="${i}">${i+1}. ${E(x.label)}</option>`).join('');
 el.innerHTML=`<div class="import-range"><b>${E(importedSections.kind)}から${elements.length}章・ページを抽出しました</b><p class="small muted">範囲を選ぶと、英文入力欄に取り込まれます。原本の画像や図表、段組みは保持されません。</p><div class="import-range-selects"><label>開始<select id="importStart">${options}</select></label><label>終了<select id="importEnd">${options}</select></label></div><div id="importRangeStatus" class="small muted"></div></div>`;
 $('#importEnd').value=String(Math.min(elements.length-1,Math.max(0,Math.floor(IMPORT_MAX_TEXT/Math.max(1,elements[0].text.length))-1)));
 importRangeChange();
}
async function importReadingFile(file){
 if(!file)return;
 if(importBusy)return;
 const msg=$('#importFileStatus');
 if(file.size>IMPORT_MAX_BYTES){if(msg)msg.textContent='ファイルは30MB以内にしてください';return;}
 importBusy=true;
 if(msg)msg.textContent='教材を解析しています…';
 try{
  const ext=file.name.split('.').pop()?.toLowerCase();
  let documentData;
  if(ext==='epub')documentData=await extractEpubSections(file);
  else if(ext==='pdf')documentData=await extractPdfSections(file);
  else if(ext==='txt')documentData={kind:'TXT',title:file.name.replace(/\.txt$/i,''),sections:[{label:'全文',text:await file.text()}]};
  else throw Error('TXT・PDF・EPUBのいずれかを選択してください');
  if(!document.getElementById('importFileStatus'))return;
  importedSections=documentData;
  const title=$('#materialTitle');if(title&&!title.value.trim())title.value=documentData.title;
  renderImportRange();
  if(msg)msg.textContent=`${documentData.kind}の読み込みが完了しました。下の英文を確認して保存してください。`;
 }catch(e){importedSections=null;if(msg)msg.textContent=`取り込みに失敗：${e.message||String(e)}`;}
 finally{importBusy=false;}
}
function applyReaderAppearance(){
 const root=$('#readerArticle'),page=$('.reader-page');if(!root)return;
 root.style.setProperty('--reading-size',`${db.settings.fontSize}px`);
 root.style.setProperty('--reading-line',String(db.settings.readerLineHeight||2.05));
 root.style.setProperty('--reading-width',db.settings.readerWidth==='wide'?'880px':'680px');
 root.classList.toggle('reading-sans',db.settings.readerFont==='sans');
 page?.classList.toggle('focus-mode',!!db.settings.focusMode);
}
function readerAppearanceChange(name,value){
 if(name==='readerLineHeight')db.settings.readerLineHeight=[1.65,2.05,2.4].includes(Number(value))?Number(value):2.05;
 if(name==='readerWidth')db.settings.readerWidth=value==='wide'?'wide':'standard';
 if(name==='readerFont')db.settings.readerFont=value==='sans'?'sans':'serif';
 persist();applyReaderAppearance();
}

function showMaterialModal(id=null){
 importedSections=null;
 const m=id?getM(id):null;
 if(id&&!m){notify('編集する教材が見つかりません');return;}
 closeModal();
 const edit=!!m, bg=document.createElement('div');
 bg.className='modal-bg';bg.id='modal';bg.dataset.editId=m?.id||'';
 const cats=[...new Set([...MATERIAL_CATEGORIES,...(m?[m.category]:[])])];
 const levels=[...new Set([...MATERIAL_LEVELS,...(m?[m.level]:[])])];
 bg.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><header class="modal-top"><h2 id="modalTitle">${edit?'教材を編集':'新しい教材を追加'}</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body"><div class="field"><label for="materialTitle">教材タイトル</label><input id="materialTitle" maxlength="120" placeholder="例：A Story About the Sea" value="${E(m?.title||'')}"></div><div class="field-grid"><div class="field"><label for="materialCategory">ジャンル</label><select id="materialCategory">${cats.map(c=>`<option value="${E(c)}" ${c===(m?.category||'小説')?'selected':''}>${E(c)}</option>`).join('')}</select></div><div class="field"><label for="materialLevel">CEFR目安</label><select id="materialLevel">${levels.map(l=>`<option value="${E(l)}" ${l===(m?.level||'B1')?'selected':''}>${E(l)}</option>`).join('')}</select></div></div><div class="field"><label for="materialFolder">保存先フォルダ</label><select id="materialFolder">${folderChoices('materials',m?folderOf(m):(currentView==='library'&&folderView.materials!=='all'?folderView.materials:'unfiled'))}</select></div><div class="field"><label for="materialBody">英文を${edit?'編集':'貼り付ける'}</label><textarea id="materialBody" rows="10" placeholder="Paste your English text here..." maxlength="120000">${E(m?.text||'')}</textarea><div class="button-row" style="justify-content:space-between"><span class="small muted"><span id="materialWords">${W(m?.text||'')}</span> words</span><button class="btn sm" data-act="choose-reading-file">${ico('upload',14)} TXT / PDF / EPUBを取り込む</button></div><input id="readingFile" type="file" accept=".txt,.pdf,.epub,text/plain,application/pdf,application/epub+zip" class="hidden"><div id="importFileStatus" class="small muted" aria-live="polite">PDFの解析にはネット接続（PDF.js）が必要です。EPUB・TXTはオフラインで取り込めます。</div><div id="importSectionPreview"></div></div><div class="callout">${edit?'タイトル・ジャンル・レベルだけの変更では読書進捗を維持します。英文を変更した場合は、読書位置・読了状態をリセットします。保存済みの単語、学習時間、テスト履歴は残りますが、以前の本文に付けた対訳メモとマーカーは消去されます。':'著作権のある文章は利用許可を確認して登録してください。教材はこのブラウザ内に保存されます。'}</div></div><footer class="modal-actions"><button class="btn" data-act="close-modal">キャンセル</button><button class="btn primary" data-act="save-material">${ico(edit?'check':'plus')} ${edit?'変更を保存':'教材を追加'}</button></footer></section>`;
 document.body.appendChild(bg);$('#materialTitle')?.focus();
}
function showAddModal(){showMaterialModal();}
function showEditModal(id){showMaterialModal(id);}
function showDeleteModal(id){
 const m=getM(id);if(!m){notify('教材が見つかりません');return;}
 closeModal();
 const savedCount=db.saved.filter(x=>x.materialId===id).length;
 const sessionCount=db.sessions.filter(x=>x.materialId===id).length;
 const quizCount=db.quizResults.filter(x=>x.materialId===id).length;
 const bg=document.createElement('div');bg.className='modal-bg';bg.id='modal';
 bg.innerHTML=`<section class="modal delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="deleteDescription"><header class="modal-top"><h2 id="modalTitle">教材を削除しますか？</h2><button class="btn icon-only ghost" data-act="close-modal" aria-label="閉じる">${ico('close')}</button></header><div class="modal-body"><p class="delete-material-name">${E(m.title)}</p><p id="deleteDescription" class="delete-description">この教材の英文と関連データを削除します。この操作は元に戻せません。</p><div class="delete-summary"><span>教材の読書進捗</span><strong>削除</strong><span>復習リスト内の項目</span><strong>${savedCount}件</strong><span>読書セッション</span><strong>${sessionCount}件</strong><span>理解度テスト履歴</span><strong>${quizCount}件</strong></div><div class="callout">必要なら先に「設定 → バックアップを保存」でデータを書き出してください。</div></div><footer class="modal-actions"><button class="btn" data-act="close-modal" id="cancelDelete">キャンセル</button><button class="btn danger" data-act="confirm-delete-material" data-id="${E(m.id)}">${ico('trash',15)} 削除する</button></footer></section>`;
 document.body.appendChild(bg);$('#cancelDelete')?.focus();
}
function closeModal(){$('#modal')?.remove();importedSections=null;}
function saveMaterial(){
 const title=$('#materialTitle')?.value.trim(),text=$('#materialBody')?.value.trim(),category=$('#materialCategory')?.value,level=$('#materialLevel')?.value,folderInput=$('#materialFolder')?.value||'unfiled',folderId=folderInput==='unfiled'?null:folderInput;
 if(!title){notify('タイトルを入力してください');$('#materialTitle')?.focus();return;}
 if(!text||W(text)<5){notify('英文を5語以上入力してください');$('#materialBody')?.focus();return;}
 if(importedSections&&Number($('#importStart')?.value)>Number($('#importEnd')?.value)){notify('取り込み範囲を正しく指定してください');return;}
 if(importedSections){const a=Number($('#importStart')?.value||0),b=Number($('#importEnd')?.value||0),raw=importedSections.sections.slice(a,b+1).map(x=>x.text).join('\n\n');if(raw.length>IMPORT_MAX_TEXT){notify('教材が12万文字を超えています。取り込み範囲を短くしてください');return;}}
 const editId=$('#modal')?.dataset.editId;
 if(editId){
  const m=getM(editId);if(!m){notify('編集する教材が見つかりません');return;}
  const changedText=m.text!==text;
  if(m.title===title&&m.text===text&&m.category===category&&m.level===level&&folderOf(m)===(folderId||'unfiled')){closeModal();notify('変更はありません');return;}
  Object.assign(m,{title,text,category,level,folderId,updatedAt:new Date().toISOString()});
  if(changedText){
   delete db.notes[editId];delete db.syntaxAnnotations[editId];delete db.customQuizzes[editId];db.highlights=db.highlights.filter(h=>h.materialId!==editId);
   const p=db.progress[editId];
   if(p)Object.assign(p,{percent:0,lastPosition:0,finished:false});
  }
  syncAutoVocabularyFolders();searchLibrary='';categoryLibrary='すべて';persist();closeModal();
  renderPage();notify(changedText?'教材を更新しました。英文が変わったため読書進捗をリセットしました。':'教材情報を更新しました');
 }else{
  const id='m'+Date.now()+Math.floor(Math.random()*9999);
  db.materials.unshift({id,title,text,category,level,folderId,createdAt:new Date().toISOString()});
  persist();closeModal();notify('教材を追加しました');readerMode='study';go('reader',id);
 }
}
function deleteMaterial(id){
 if(!deleteMaterialRecord(id)){closeModal();notify('教材が見つかりません');return;}
 for(const k of FOLDER_TYPES)for(const selected of [...bulkSelected[k]])if(!db[k].some(x=>x.id===selected))bulkSelected[k].delete(selected);
 if(categoryLibrary!=='すべて'&&!db.materials.some(x=>x.category===categoryLibrary))categoryLibrary='すべて';
 persist();closeModal();renderPage();notify('教材と関連データを削除しました');
}
function changeFont(delta){db.settings.fontSize=Math.min(28,Math.max(13,db.settings.fontSize+delta));persist();if(currentView==='reader'){const article=$('#readerArticle');if(article)article.style.setProperty('--reading-size',db.settings.fontSize+'px');}else{const el=$('#settingsFont');if(el)el.textContent=db.settings.fontSize+'px';}notify(`本文の文字サイズ：${db.settings.fontSize}px`);}
function exportBackup(){downloadJSON(backupPayload(),backupFileName());notify('バックアップを書き出しました');}
function importBackup(){const el=document.createElement('input');el.type='file';el.accept='.json,application/json';el.style.display='none';document.body.appendChild(el);el.addEventListener('change',async()=>{try{const f=el.files?.[0];if(!f)return;if(f.size>10*1024*1024)throw Error('ファイルが大きすぎます');const parsed=JSON.parse(await f.text());checkBackupShape(parsed);if(!confirm('現在の教材・学習履歴をバックアップ内容に置き換えます。よろしいですか？'))return;await snapshotCreate('safety');applyBackupData(parsed);storeSyncRevision(null);notify('バックアップを復元しました。復元前のデータも端末内に保存しました');}catch(e){notify(`読み込み失敗：${e.message}`);}finally{el.remove();}});el.click();}
async function checkAPI(){if(STATIC_DEPLOY){notify('GitHub Pages版にAI APIはありません。AI機能はサーバー版で利用してください。');return;}try{const res=await fetch('/api/status',{signal:AbortSignal.timeout(5000)}),result=await res.json();notify(result.aiEnabled?`AI接続は有効です（モデル：${result.model}）`:'サーバーは動作中です。AIのAPIキーは未設定です。');}catch{notify('静的ファイルとして開いています。AI機能はNodeサーバーを起動すると使えます。');}}
async function handleAction(btn){const act=btn.dataset.act,id=btn.dataset.id;
 switch(act){
 case 'nav':go(btn.dataset.view);break;
 case 'open':readerMode='study';go('reader',id);break;
 case 'add':showAddModal();break;
 case 'folder-select':if(validKind(btn.dataset.kind)){folderView[btn.dataset.kind]=id;reviewSession=null;renderPage();}break;
 case 'folder-new':showFolderModal(btn.dataset.kind);break;
 case 'folder-child':showFolderModal(btn.dataset.kind,null,id);break;
 case 'folder-expand':{const k=btn.dataset.kind;if(!validKind(k))break;const set=folderCollapsed[k];if(set.has(id))set.delete(id);else set.add(id);renderPage();break;}
 case 'folder-rename':showFolderModal(btn.dataset.kind,id);break;
 case 'folder-save':saveFolder();break;
 case 'folder-delete':removeFolder(btn.dataset.kind,id);break;
 case 'bulk-all':bulkSelectVisible(btn.dataset.kind);break;
 case 'bulk-clear':bulkSelected[btn.dataset.kind]?.clear();renderPage();break;
 case 'bulk-move':bulkMove(btn.dataset.kind);break;
 case 'bulk-delete':bulkDelete(btn.dataset.kind);break;
 case 'auto-classify':autoClassifyExistingCards();break;
 case 'item-up':reorderItem(btn.dataset.kind,id,-1);break;
 case 'item-down':reorderItem(btn.dataset.kind,id,1);break;
 case 'edit-material':showEditModal(id);break;
 case 'delete-material':showDeleteModal(id);break;
 case 'confirm-delete-material':deleteMaterial(id);break;
 case 'close-modal':closeModal();break;
 case 'save-material':saveMaterial();break;
 case 'choose-txt':case 'choose-reading-file':$('#readingFile')?.click();break;
 case 'reader-focus':db.settings.focusMode=!db.settings.focusMode;persist();renderPage();break;
 case 'reader-mode':{if(readerMode===btn.dataset.mode)break;stopSession();readerMode=btn.dataset.mode;examReadFinished=false;if(readerMode==='exam')getP(currentId).lastPosition=0;startSession();panelSelection=null;panelMessage=null;removeFloatingToolbar();renderPage();notify(readerMode==='exam'?'演習モード：辞書と解説を非表示にしました':'精読モードに切り替えました');break;}
 case 'syntax-toggle':db.settings.syntaxEnabled=!db.settings.syntaxEnabled;persist();refreshArticlePreservingScroll();renderPage();notify(db.settings.syntaxEnabled?'構文の色分けを表示しました':'構文の色分けを隠しました');break;
 case 'syntax-tag':syntaxTagRange(btn.dataset.role);break;
 case 'syntax-editor':showSyntaxEditor(Number(btn.dataset.index));break;
 case 'syntax-remove':syntaxRemoveAt(Number(btn.dataset.index),Number(btn.dataset.item));break;
 case 'syntax-reset':syntaxReset(Number(btn.dataset.index));break;
 case 'syntax-ai':await analyzeSyntaxAI(Number(btn.dataset.index));break;
 case 'parallel-translation':db.settings.parallelTranslation=!db.settings.parallelTranslation;persist();renderPage();notify(db.settings.parallelTranslation?'英文の下に和訳を表示します。未登録の文は手入力できます':'対訳表示をオフにしました');break;
 case 'select-sentence':showSentence(Number(btn.dataset.index));break;
 case 'edit-sentence':openSentenceEditor(Number(btn.dataset.index));break;
 case 'save-sentence-note':saveSentenceNote();break;
 case 'add-marker':toggleMarker(btn.dataset.color||'yellow');break;
 case 'remove-marker':removeMarker(id);if($('#modal')?.querySelector('.marker-list'))showMarkerList();break;
 case 'markers-list':showMarkerList();break;
 case 'jump-marker':{const idx=Number(btn.dataset.index);closeModal();const el=$(`#readerArticle .sentence[data-sentence="${idx}"]`);el?.scrollIntoView({block:'center',behavior:'smooth'});showSentence(idx);break;}
 case 'font-minus':changeFont(-1);break;
 case 'font-plus':changeFont(1);break;
 case 'dark':db.settings.dark=!db.settings.dark;persist();renderPage();break;
 case 'speak':{const m=getM(currentId);if(m)pronounce(m.text);break;}
 case 'speak-selected':if(panelSelection)pronounce(panelSelection.text);break;
 case 'complete':markComplete();break;
 case 'close-panel':panelSelection=null;panelMessage=null;removeFloatingToolbar();renderInsightPanel();break;
 case 'panel-tab':if(!panelSelection)break;panelTab=btn.dataset.tab;panelMessage=null;renderInsightPanel();removeFloatingToolbar();break;
 case 'ask-ai':await askAI();break;
 case 'save-selection':saveSelection();removeFloatingToolbar();break;
 case 'edit-gloss':openGlossEditor();break;
 case 'save-gloss':saveGloss();break;
 case 'delete-gloss':deleteGloss();break;
 case 'download-damaged':downloadDamaged();break;
 case 'reset-damaged':resetDamaged();break;
 case 'start-quiz':startQuiz();break;
 case 'edit-quiz':showQuizEditor();break;
 case 'add-question':addQuestionEditor();break;
 case 'delete-question':{const q=btn.closest('[data-edit-question]');q?.remove();document.querySelectorAll('[data-edit-question]').forEach((el,i)=>{el.dataset.editQuestion=i;const heading=el.querySelector('.quiz-question-top b');if(heading)heading.textContent=`問題 ${i+1}`;});break;}
 case 'save-quiz-editor':saveQuizEditor();break;
 case 'ai-quiz':await generateQuizAI();break;
 case 'begin-quiz':enterQuiz();break;
 case 'jump-evidence':jumpToEvidence(id,Number(btn.dataset.index));break;
 case 'answer':if(!activeQuiz||activeQuiz.showResult)return;{const scrollY=window.scrollY;activeQuiz.answers[Number(btn.dataset.q)]=Number(btn.dataset.option);renderPage();window.scrollTo(0,scrollY);}break;
 case 'submit-quiz':submitQuiz();break;
 case 'reset-quiz':if(activeQuiz){activeQuiz.answers=activeQuiz.questions.map(()=>null);activeQuiz.showResult=false;activeQuiz.elapsed=0;activeQuiz.timedOut=false;renderPage();}break;
 case 'remove-saved':db.saved=db.saved.filter(x=>x.id!==id);delete db.srs[id];bulkSelected.saved.delete(id);persist();renderPage();notify('復習リストから削除しました');break;
 case 'jump-saved':if(getM(id)){readerMode='study';go('reader',id);}else notify('元の教材は削除されています');break;
 case 'start-review':startReview(btn.dataset.scope);break;
 case 'review-reveal':revealReview();break;
 case 'review-grade':gradeReview(btn.dataset.grade);break;
 case 'exit-review':reviewSession=null;renderPage();break;
 case 'review-filter':reviewFilter=btn.dataset.filter||'all';renderPage();break;
 case 'analytics-weak':reviewSession=null;reviewFilter='weak';reviewSearch='';go('review');break;
 case 'stats-range':db.settings.statsRange=['7','30','90','all'].includes(btn.dataset.range)?btn.dataset.range:'30';persist();renderPage();break;
 case 'analytics-ai':await generateAnalyticsAI();break;
 case 'review-edit':showReviewEditor(id);break;
 case 'save-review-edit':saveReviewEditor();break;
 case 'review-speak':{const item=db.saved.find(x=>x.id===id);if(item)pronounce(item.text);break;}
 case 'toggle-meaning':{const index=btn.dataset.index;const p=$(`#meaning-${index}`);if(p){const isHidden=p.dataset.hidden==='yes';p.dataset.hidden=isHidden?'no':'yes';p.textContent=isHidden?p.dataset.original:'••••••••';btn.innerHTML=`${ico('eye',13)} ${isHidden?'意味を隠す':'意味を表示'}`;}break;}
 case 'export':exportBackup();break;
 case 'share-backup':await shareBackup();break;
 case 'hide-install-banner':hideInstallBanner();break;
 case 'import-backup':importBackup();break;
 case 'install-app':await installPWA();break;
 case 'snapshot-create':try{await snapshotCreate('manual');await updateSnapshotList();notify('復元ポイントを保存しました');}catch(e){notify('保存できません：'+e.message);}break;
 case 'snapshot-restore':await restoreSnapshot(id);break;
 case 'snapshot-delete':if(confirm('この復元ポイントを削除しますか？')){await snapshotDelete(id);await updateSnapshotList();notify('削除しました');}break;
 case 'sync-check':await checkSyncServer();break;
 case 'sync-push':syncToken=$('#syncToken')?.value.trim()||syncToken;await pushSync();break;
 case 'sync-pull':syncToken=$('#syncToken')?.value.trim()||syncToken;await pullSync();break;
 case 'check-api':checkAPI();break;
 case 'choose-dictionary':$('#dictionaryFile')?.click();break;
 case 'clear-dictionary':{if(!importedDictionaryCount)break;if(!confirm('追加辞書を削除しますか？内蔵辞書・学習データは残ります。'))break;try{await clearStoredDictionary();importedDictionary=Object.create(null);importedDictionaryCount=0;renderPage();notify('追加辞書を削除しました');}catch(e){notify('削除できませんでした：'+e.message);}break;}
 case 'import-txt':break;
 default:break;
 }}
function handleDocumentClick(event){const btn=event.target.closest('[data-act]');if(btn){event.preventDefault();handleAction(btn);return;}const phrase=event.target.closest('.phrase');
 if(phrase&&currentView==='reader'&&readerMode==='study'){
  const currentSel=window.getSelection();if(currentSel&&!currentSel.isCollapsed&&currentSel.toString().trim())return;
  const context=sentenceFor(phrase),text=phrase.dataset.phrase;
  db.lookups.push({materialId:currentId,word:text,date:new Date().toISOString()});persist();
  selectWord(text,context,phrase,'phrase');panelTab='meaning';renderInsightPanel();return;
 }
 const word=event.target.closest('.word');if(word&&currentView==='reader'&&readerMode==='study'){const currentSel=window.getSelection();if(currentSel&&!currentSel.isCollapsed&&currentSel.toString().trim())return;const context=sentenceFor(word);db.lookups.push({materialId:currentId,word:word.dataset.word,date:new Date().toISOString()});if(db.lookups.length>3000)db.lookups.shift();persist();selectWord(word.dataset.word,context,word);return;}
 const sentence=event.target.closest('#readerArticle .sentence');
 if(sentence&&currentView==='reader'&&readerMode==='study'){
  const currentSel=window.getSelection();if(currentSel&&!currentSel.isCollapsed&&currentSel.toString().trim())return;
  showSentence(Number(sentence.dataset.sentence));return;
 }
 const bg=event.target.closest('.modal-bg');if(bg&&event.target===bg)closeModal();}
function handleInputs(event){
 if(event.type==='change'&&event.target.matches('[data-bulk-kind]')){bulkToggle(event.target.dataset.bulkKind,event.target.dataset.id,event.target.checked);return;}
 if(event.type==='change'&&/^searchAll-(materials|saved)$/.test(event.target.id)){
  const kind=event.target.id.slice('searchAll-'.length);globalSearch[kind]=event.target.checked;renderPage();return;
 }
if(['importStart','importEnd'].includes(event.target.id)&&event.type==='change'){importRangeChange();return;}if(['readerLineHeight','readerWidth','readerFont'].includes(event.target.id)&&event.type==='change'){readerAppearanceChange(event.target.id,event.target.value);return;}if(event.target.id==='reviewSearch'&&event.type==='input'){reviewSearch=event.target.value;const items=selectReviewItems();const cards=$('#reviewListCards'),counter=$('#reviewResultCount');if(cards)cards.innerHTML=renderReviewCards(items);renderBulkBar('saved');if(counter)counter.textContent=items.length+'件表示';}
 if(event.target.id==='librarySearch'&&event.type==='input'){searchLibrary=event.target.value;renderLibraryCards();}if(event.target.id==='libraryCategory'){categoryLibrary=event.target.value;renderLibraryCards();}
 if(event.type==='change'&&event.target.matches('.collection-move')){moveItemToFolder(event.target.dataset.kind,event.target.dataset.id,event.target.value);return;}
 if(event.type==='change'&&event.target.id==='librarySort'){db.settings.librarySort=event.target.value;persist();renderPage();return;}
 if(event.type==='change'&&event.target.id==='reviewSort'){db.settings.reviewSort=event.target.value;persist();renderPage();return;}if(event.target.id==='materialBody'){$('#materialWords').textContent=W(event.target.value);}if(event.target.id==='voiceRate'){db.settings.voiceRate=Number(event.target.value);persist();}}
async function handleFileInput(event){
 if(event.target.id==='dictionaryFile'){const file=event.target.files?.[0];await importOfflineDictionary(file);event.target.value='';return;}
 if(event.target.id==='readingFile'||event.target.id==='txtFile'){
  const file=event.target.files?.[0];if(!file)return;
  await importReadingFile(file);event.target.value='';
 }
}
let draggingItem=null;
function setupCollectionDrag(){
 document.addEventListener('dragstart',e=>{
  const card=e.target.closest?.('[data-item-kind][data-item-id]');
  if(!card||!card.draggable||!manualMoveAllowed(card.dataset.itemKind)||e.target.closest('button,select,input,textarea'))return;
  draggingItem={kind:card.dataset.itemKind,id:card.dataset.itemId};
  e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggingItem.id);
  card.classList.add('dragging');
 });
 document.addEventListener('dragover',e=>{
  const card=e.target.closest?.('[data-item-kind][data-item-id]');
  if(!draggingItem||!card||card.dataset.itemKind!==draggingItem.kind||card.dataset.itemId===draggingItem.id)return;
  if(!manualMoveAllowed(draggingItem.kind))return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  document.querySelectorAll('.drag-target').forEach(el=>el.classList.remove('drag-target'));
  card.classList.add('drag-target');
 });
 document.addEventListener('drop',e=>{
  const card=e.target.closest?.('[data-item-kind][data-item-id]'),src=draggingItem;
  if(!src||!card||card.dataset.itemKind!==src.kind||card.dataset.itemId===src.id||!manualMoveAllowed(src.kind))return;
  e.preventDefault();
  const list=db[src.kind],from=list.findIndex(x=>x.id===src.id),item=list[from];
  const target=list.find(x=>x.id===card.dataset.itemId);
  if(!item||!target||folderOf(item)!==folderOf(target))return;
  const after=e.clientY>card.getBoundingClientRect().top+card.getBoundingClientRect().height/2;
  list.splice(from,1);const to=list.indexOf(target);list.splice(to+(after?1:0),0,item);
  draggingItem=null;persist();renderPage();notify('順番を保存しました');
 });
 document.addEventListener('dragend',()=>{draggingItem=null;document.querySelectorAll('.drag-target,.dragging').forEach(el=>el.classList.remove('drag-target','dragging'));});
}

function setupEvents(){document.addEventListener('click',handleDocumentClick);document.addEventListener('input',handleInputs);document.addEventListener('change',e=>{handleFileInput(e);handleInputs(e);});document.addEventListener('mouseup',()=>{clearTimeout(selectionTimer);selectionTimer=setTimeout(onTextSelection,30);});document.addEventListener('touchend',()=>{clearTimeout(selectionTimer);selectionTimer=setTimeout(onTextSelection,180);});document.addEventListener('keyup',e=>{if(e.key==='Escape'){closeModal();panelSelection=null;removeFloatingToolbar();renderInsightPanel();}if(e.key==='Shift'||e.key.startsWith('Arrow')){clearTimeout(selectionTimer);selectionTimer=setTimeout(onTextSelection,30);}});document.addEventListener('visibilitychange',()=>{if(document.hidden){persist();stopSpeech();}});window.addEventListener('beforeunload',()=>{if(currentView==='reader')stopSession();persist();});window.addEventListener('resize',removeFloatingToolbar);}
setupEvents();setupCollectionDrag();ensureTimer();renderShell();loadOfflineDictionary();setupPWA();
})();
