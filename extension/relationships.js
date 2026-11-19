'use strict';

const relationshipsKey = 'follow-studio-relationships';
const relationshipJobKey = 'follow-studio-relationship-job';
const relationshipAlarm = 'follow-studio-relationship-timeout';

async function relationshipJob() {
  return (await chrome.storage.local.get(relationshipJobKey))[relationshipJobKey];
}

async function stopLegacyRelationshipScan() {
  const job = await relationshipJob();
  if (!job?.running) return;
  await chrome.storage.local.set({[relationshipJobKey]: {...job, running: false,
    status: 'Otomatik canlı tarama kapatıldı. Önceki kayıt korundu.'}});
  await chrome.alarms.clear(relationshipAlarm);
  if (job.tabId == null) return;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (job.url && (tab.url === job.url || tab.pendingUrl === job.url)) await chrome.tabs.remove(job.tabId);
  } catch {}
}

function relationshipChanges(previous, current) {
  if (!previous) return [];
  const followers = new Set(current.followers);
  const following = new Set(current.following);
  const previousFollowing = new Set(previous.following);
  const lostFollowers = previous.followers.filter(name => !followers.has(name));
  const lostMutualOnly = previous.followers.filter(name => previousFollowing.has(name) &&
    followers.has(name) && !following.has(name));
  return [
    ...lostFollowers.map(name => ({name, type: 'lost_follower', wasMutual: previousFollowing.has(name)})),
    ...lostMutualOnly.map(name => ({name, type: 'mutual_ended', wasMutual: true}))
  ].map(event => ({...event, from: previous.at, to: current.at}));
}

function validRelationshipList(names, count) {
  return Number.isSafeInteger(count) && count >= 0 && Array.isArray(names) && names.length === count &&
    new Set(names).size === names.length && names.every(name => typeof name === 'string' &&
      normalizeFollowName(name) === name);
}

async function saveRelationshipSnapshot(data, saved, account, username, snapshot, photos = saved?.photos) {
  const baseline = saved?.latest.source === 'archive' ? saved.latest : undefined;
  if (baseline && snapshot.at <= baseline.at) throw new Error('Yeni kaydın tarihi son kayıttan daha yeni olmalı.');
  const changes = relationshipChanges(baseline, snapshot);
  const record = {account, username, latest: snapshot, photos,
    scans: [...(saved?.scans || []), {at: snapshot.at, followers: snapshot.followers.length,
      following: snapshot.following.length, changes: changes.length, source: snapshot.source}],
    events: [...changes, ...(saved?.events || [])]};
  data.accounts = [...data.accounts.filter(item => !sameFollowAccount(item.account, account)), record];
  await chrome.storage.local.set({[relationshipsKey]: data});
  return changes.length;
}

function verifiedRelationshipPhotos(names, photos) {
  if (!photos || typeof photos !== 'object') return {};
  return Object.fromEntries(Object.entries(photos).filter(([name, photo]) => {
    if (!names.has(name) || typeof photo !== 'string' || photo.length > 2048) return false;
    try {
      const url = new URL(photo);
      return url.protocol === 'https:' && !url.username && !url.password &&
        /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname);
    } catch {
      return false;
    }
  }));
}

async function handleRelationships(message, sender) {
  if (sender.frameId !== 0) throw new Error('Tarama ana sekmeden başlatılmalı.');
  if (message.type !== 'relationships-state' && message.type !== 'relationships-import') {
    await stopLegacyRelationshipScan();
    throw new Error('Otomatik canlı tarama kapatıldı.');
  }
  const job = await relationshipJob();
  const account = await senderFollowAccount(sender);
  const data = (await chrome.storage.local.get(relationshipsKey))[relationshipsKey] || {accounts: []};
  const saved = data.accounts.find(record => sameFollowAccount(record.account, account));
  if (message.type === 'relationships-state') {
    const summary = saved && {account: saved.account, username: saved.username, scans: saved.scans, events: saved.events, latest: {at: saved.latest.at,
      followers: saved.latest.followers.length, following: saved.latest.following.length, source: saved.latest.source}};
    return {account, saved: summary, job: sameFollowAccount(job?.account, account) ? job : null};
  }
  if (!sameFollowAccount(message.expectedAccount, account)) throw new Error('Arşiv okunurken hesap değişti. Yeniden seç.');
  const username = normalizeFollowName(message.username || '');
  if (!username || message.allTime !== true) throw new Error('Kendi kullanıcı adını ve tüm zamanlar onayını kontrol et.');
  if (!Number.isSafeInteger(message.at) || message.at <= 0 || message.at > Date.now()) {
    throw new Error('Arşivin hazırlanma tarihini doğru gir.');
  }
  if (!validRelationshipList(message.followers, message.followers?.length) ||
      !validRelationshipList(message.following, message.following?.length)) throw new Error('Arşivdeki kullanıcı listeleri geçersiz.');
  const snapshot = {at: message.at, followers: message.followers.slice().sort(),
    following: message.following.slice().sort(), source: 'archive'};
  const changes = await saveRelationshipSnapshot(data, saved, account, username, snapshot);
  await chrome.storage.local.set({[relationshipJobKey]: {account, username, running: false,
    status: saved?.latest.source === 'archive' ? 'Arşiv kaydedildi. ' + changes + ' değişiklik bulundu.' : 'İlk arşiv kaydı oluşturuldu.'}});
  return {changes};
}

chrome.runtime.onStartup.addListener(() => queueFollowOperation(stopLegacyRelationshipScan));
