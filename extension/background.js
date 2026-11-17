'use strict';

const jobKey = 'local-unfollow-job';
const sessionKey = 'follow-studio-session';
const photoCacheKey = 'follow-studio-observed-photos';
const unfollowScanMaxAge = 10 * 60 * 1000;
const newSession = () => ({owner: null, workers: {}, pendingOpen: {}});
let operations = Promise.resolve();
importScripts('follow-queue.js');
importScripts('relationships.js');
importScripts('dm-queue.js');

function instagram(url) {
  try { return new URL(url).origin === 'https://www.instagram.com'; } catch { return false; }
}
async function session() { return (await chrome.storage.session.get(sessionKey))[sessionKey] || newSession(); }
async function save(state) { await chrome.storage.session.set({[sessionKey]: state}); }
async function alive(tabId) { try { await chrome.tabs.get(tabId); return true; } catch { return false; } }

function validUnfollowArchive(archive) {
  return !archive?.archiveWarning && Array.isArray(archive?.followerNames) && Array.isArray(archive.followingNames);
}

function recentCheck(at) {
  const age = Date.now() - at;
  return Number.isFinite(age) && age >= 0 && age < unfollowScanMaxAge;
}

async function liveUnfollowSnapshot(account) {
  const data = (await chrome.storage.local.get(relationshipsKey))[relationshipsKey];
  const snapshot = data?.accounts.find(record => sameFollowAccount(record.account, account))?.latest;
  return snapshot?.source === 'live' && recentCheck(snapshot.at) ? snapshot : null;
}

const unfollowDataKeys = ['follow-studio-cache', 'follow-studio-protected'];

async function verifyUnfollowCandidate(sender, state, username, data) {
  const run = state.unfollowRun;
  const account = await senderFollowAccount(sender);
  if (!run || !sameFollowAccount(run.account, account)) throw new Error('Instagram hesabı işlem sırasında değişti.');
  const records = data || await chrome.storage.local.get(unfollowDataKeys);
  const archive = records['follow-studio-cache'];
  if (!validUnfollowArchive(archive) || archive.importedAt !== run.archiveAt || archive.filename !== run.filename) {
    throw new Error('ZIP arşivi işlem sırasında değişti. Kuyruğu yeniden başlat.');
  }
  if (Object.hasOwn(records['follow-studio-protected'] || {}, username)) {
    throw Object.assign(new Error('Korunan hesap, atlandı.'), {outcome: 'protected'});
  }
  if (archive.followerNames.includes(username) || !archive.followingNames.includes(username)) {
    throw Object.assign(new Error('ZIP takipçi doğrulaması başarısız; işlem yapılmadı.'), {outcome: 'follower'});
  }
  if (run.liveAt == null) return;
  const snapshot = await liveUnfollowSnapshot(account);
  if (snapshot?.at !== run.liveAt) throw new Error('Canlı doğrulamanın süresi doldu. Kuyruğu yeniden başlat.');
  if (snapshot.followers.includes(username)) {
    throw Object.assign(new Error('Canlı listede seni takip ediyor; atlandı.'), {outcome: 'follower'});
  }
  if (!snapshot.following.includes(username)) {
    throw Object.assign(new Error('Canlı takip edilenler listesinde doğrulanamadı; atlandı.'), {outcome: 'unverified'});
  }
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !instagram(sender.url)) throw new Error('Geçersiz eklenti isteği.');
  const tabId = sender.tab.id;
  const state = await session();
  if (message.type.startsWith('relationships-')) return handleRelationships(message, sender);
  if (message.type.startsWith('follow-')) return handleFollow(message, sender, state);
  if (message.type.startsWith('dm-')) return handleDm(message, sender, state);
  if (message.type === 'studio-ready') {
    await stopLegacyRelationshipScan();
    const open = Boolean(state.pendingOpen[tabId]);
    delete state.pendingOpen[tabId]; await save(state);
    return {open};
  }
  if (message.type === 'studio-profile-details' && sender.frameId === 0) {
    const account = await senderFollowAccount(sender);
    const storage = await chrome.storage.local.get([relationshipsKey, photoCacheKey, 'follow-studio-cache',
      'follow-studio-protected', 'follow-studio-frozen']);
    const data = storage[relationshipsKey];
    const saved = data?.accounts.find(record => sameFollowAccount(record.account, account));
    const scan = await relationshipJob();
    const names = new Set((storage['follow-studio-cache']?.items || []).map(item => item.name));
    for (const name of Object.keys(storage['follow-studio-protected'] || {})) names.add(name);
    for (const name of Object.keys(storage['follow-studio-frozen'] || {})) names.add(name);
    const cached = storage[photoCacheKey];
    const observed = sameFollowAccount(cached?.account, account) ? cached.photos : {};
    const newPhotos = verifiedRelationshipPhotos(names, message.photos);
    const changed = Object.entries(newPhotos).some(([name, src]) => observed[name] !== src);
    if (changed) {
      await chrome.storage.local.set({[photoCacheKey]: {account,
        photos: verifiedRelationshipPhotos(names, {...observed, ...newPhotos})}});
    }
    const photos = {...saved?.photos, ...(sameFollowAccount(scan?.account, account) ? scan.photos : {}),
      ...observed, ...newPhotos};
    const queue = await readFollowQueue();
    const followedAt = new Map();
    if (sameFollowAccount(queue.account, account)) {
      for (const entry of queue.history || []) {
        if (entry.outcome === 'followed' && Number.isSafeInteger(entry.time) && entry.time <= Date.now()) {
          followedAt.set(entry.name, Math.max(entry.time, followedAt.get(entry.name) || 0));
        }
      }
    }
    return {photos, followedAt: Object.fromEntries(followedAt)};
  }
  if (message.type === 'studio-claim') {
    if (sender.frameId !== 0) throw new Error('İşlem ana sekmeden başlatılmalı.');
    if (state.owner !== null && await alive(state.owner)) return {claimed: false};
    if ((await relationshipJob())?.running) throw new Error('Önce takipleşme taramasını durdur.');
    if ((await readFollowQueue()).running) throw new Error('Takip kuyruğunu önce durdur.');
    if ((await readDmQueue())?.running) throw new Error('Önce mesaj işlemini durdur.');
    const archive = (await chrome.storage.local.get('follow-studio-cache'))['follow-studio-cache'];
    if (!validUnfollowArchive(archive)) throw new Error('Önce tüm zamanları içeren takipçi JSON ZIP’ini yükle.');
    const account = await senderFollowAccount(sender);
    const snapshot = await liveUnfollowSnapshot(account);
    state.unfollowRun = {account, archiveAt: archive.importedAt, filename: archive.filename, liveAt: snapshot?.at};
    state.owner = tabId;
    await save(state);
    return {claimed: true};
  }
  if (message.type === 'studio-verify-candidate') {
    if (state.owner !== tabId || sender.frameId !== 0) throw new Error('Bu sekme çalışan işlemin sahibi değil.');
    await verifyUnfollowCandidate(sender, state, message.username);
    return {};
  }
  if (message.type === 'studio-check') {
    const data = await chrome.storage.local.get([jobKey, ...unfollowDataKeys]);
    const job = data[jobKey];
    const profile = new URL(sender.url).pathname.split('/').filter(Boolean)[0];
    const worker = state.workers[tabId];
    const owned = state.owner !== null && ((tabId === state.owner && sender.frameId > 0) ||
      (worker && worker.owner === state.owner && worker.job === message.id));
    if (!owned || profile !== message.username || !job || job.id !== message.id || job.username !== message.username || job.state !== 'running') throw new Error('İşlem durduruldu veya başka bir sekmeye ait.');
    await verifyUnfollowCandidate(sender, state, message.username, data);
    return {job};
  }
  if (message.type === 'studio-open-worker') {
    if (state.owner !== tabId || sender.frameId !== 0) throw new Error('Bu sekme çalışan işlemin sahibi değil.');
    const url = new URL(message.url);
    const job = (await chrome.storage.local.get(jobKey))[jobKey];
    if (!instagram(url.href) || !job || job.state !== 'running' || url.searchParams.get('local_unfollow_job') !== job.id || url.pathname !== '/' + job.username + '/') throw new Error('Geçersiz işlem adresi.');
    await verifyUnfollowCandidate(sender, state, job.username);
    const tab = await chrome.tabs.create({url: url.href, active: false});
    state.workers[tab.id] = {owner: tabId, job: job.id}; await save(state);
    return {tabId: tab.id};
  }
  if (message.type === 'studio-close-worker') {
    if (state.owner !== tabId || !state.workers[message.tabId] || state.workers[message.tabId].owner !== tabId) throw new Error('Sekme bu işleme ait değil.');
    delete state.workers[message.tabId]; await save(state);
    try { await chrome.tabs.remove(message.tabId); } catch {}
    return {};
  }
  if (message.type === 'studio-release') {
    if (state.owner === tabId && sender.frameId === 0) {
      state.owner = null;
      delete state.unfollowRun;
      const workers = Object.entries(state.workers).filter(([, record]) => record.owner === tabId);
      for (const [id] of workers) delete state.workers[id];
      await save(state);
      for (const [id] of workers) { try { await chrome.tabs.remove(Number(id)); } catch {} }
    }
    return {};
  }
  throw new Error('Desteklenmeyen istek.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  operations = operations.then(() => handle(message, sender)).then(
    result => respond({ok: true, ...result}),
    error => respond({ok: false, error: error.message, outcome: error.outcome})
  );
  return true;
});

chrome.action.onClicked.addListener(async current => {
  try {
    if (!current.id || !instagram(current.url)) {
      const tab = await chrome.tabs.create({url: 'https://www.instagram.com/', active: true});
      const state = await session(); state.pendingOpen[tab.id] = true; await save(state);
      return;
    }
    try { await chrome.tabs.sendMessage(current.id, {type: 'studio-open'}, {frameId: 0}); }
    catch {
      const state = await session(); state.pendingOpen[current.id] = true; await save(state);
      await chrome.tabs.reload(current.id);
    }
  } catch (error) { console.error('Follow Studio:', error.message); }
});

function cleanup(tabId, navigating = false) {
  operations = operations.then(async () => {
    const state = await session();
    if (navigating && state.owner !== tabId) return;
    delete state.pendingOpen[tabId]; delete state.workers[tabId];
    if (state.owner === tabId) {
      state.owner = null;
      delete state.unfollowRun;
      const data = await chrome.storage.local.get(jobKey);
      if (data[jobKey]) await chrome.storage.local.set({[jobKey]: {...data[jobKey], state: 'stopped'}});
      const workers = Object.keys(state.workers); state.workers = {};
      await save(state);
      for (const id of workers) { try { await chrome.tabs.remove(Number(id)); } catch {} }
    } else await save(state);
  }).catch(error => console.error('Follow Studio:', error.message));
}
chrome.tabs.onRemoved.addListener(tabId => cleanup(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') cleanup(tabId, true);
});

// Keep the computer awake throughout a running queue, including scheduled breaks.
// Reconcile durable state whenever the MV3 worker starts, since it can be suspended
// between alarms. Serialize changes so a late start cannot override a stop.
let powerUpdates = Promise.resolve();
function refreshFollowPower() {
  powerUpdates = powerUpdates.then(async () => {
    const state = await readFollowQueue();
    if (state.running) chrome.power.requestKeepAwake('system');
    else chrome.power.releaseKeepAwake();
  }).catch(error => console.error('Follow Studio güç yönetimi:', error.message));
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'follow-studio-follow-queue')) refreshFollowPower();
});
refreshFollowPower();
