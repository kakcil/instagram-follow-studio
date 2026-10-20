'use strict';

const jobKey = 'local-unfollow-job';
const sessionKey = 'follow-studio-session';
const newSession = () => ({owner: null, workers: {}, pendingOpen: {}});
let operations = Promise.resolve();

function instagram(url) {
  try { return new URL(url).origin === 'https://www.instagram.com'; } catch { return false; }
}
async function session() { return (await chrome.storage.session.get(sessionKey))[sessionKey] || newSession(); }
async function save(state) { await chrome.storage.session.set({[sessionKey]: state}); }
async function alive(tabId) { try { await chrome.tabs.get(tabId); return true; } catch { return false; } }

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !instagram(sender.url)) throw new Error('Geçersiz eklenti isteği.');
  const tabId = sender.tab.id;
  const state = await session();
  if (message.type === 'studio-ready') {
    const open = Boolean(state.pendingOpen[tabId]);
    delete state.pendingOpen[tabId]; await save(state);
    return {open};
  }
  if (message.type === 'studio-claim') {
    if (sender.frameId !== 0) throw new Error('İşlem ana sekmeden başlatılmalı.');
    if (state.owner !== null && await alive(state.owner)) return {claimed: false};
    state.owner = tabId; await save(state);
    return {claimed: true};
  }
  if (message.type === 'studio-check') {
    const data = await chrome.storage.local.get([jobKey, 'follow-studio-cache', 'follow-studio-protected']);
    const job = data[jobKey], archive = data['follow-studio-cache'];
    const protectedAccounts = data['follow-studio-protected'] || {};
    const profile = new URL(sender.url).pathname.split('/').filter(Boolean)[0];
    const worker = state.workers[tabId];
    const owned = state.owner !== null && ((tabId === state.owner && sender.frameId > 0) ||
      (worker && worker.owner === state.owner && worker.job === message.id));
    if (!owned || profile !== message.username || !job || job.id !== message.id || job.username !== message.username || job.state !== 'running') throw new Error('İşlem durduruldu veya başka bir sekmeye ait.');
    if (Object.prototype.hasOwnProperty.call(protectedAccounts, message.username)) throw Object.assign(new Error('Korunan hesap, atlandı.'), {outcome: 'protected'});
    if (!archive || archive.archiveWarning || !Array.isArray(archive.followerNames) || !Array.isArray(archive.followingNames) ||
        archive.followerNames.includes(message.username) || !archive.followingNames.includes(message.username)) throw Object.assign(new Error('ZIP takipçi doğrulaması başarısız; işlem yapılmadı.'), {outcome: 'follower'});
    return {job};
  }
  if (message.type === 'studio-open-worker') {
    if (state.owner !== tabId || sender.frameId !== 0) throw new Error('Bu sekme çalışan işlemin sahibi değil.');
    const url = new URL(message.url);
    const job = (await chrome.storage.local.get(jobKey))[jobKey];
    if (!instagram(url.href) || !job || job.state !== 'running' || url.searchParams.get('local_unfollow_job') !== job.id || url.pathname !== '/' + job.username + '/') throw new Error('Geçersiz işlem adresi.');
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
