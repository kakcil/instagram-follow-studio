'use strict';

const relationshipsKey = 'follow-studio-relationships';
const relationshipJobKey = 'follow-studio-relationship-job';
const relationshipAlarm = 'follow-studio-relationship-timeout';

async function relationshipJob() {
  return (await chrome.storage.local.get(relationshipJobKey))[relationshipJobKey];
}

function relationshipURL(job, value) {
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase().replace(/\/$/, '');
    return url.origin === 'https://www.instagram.com' &&
      ['', '/followers', '/following'].some(suffix => path === '/' + job.username + suffix);
  } catch { return false; }
}

async function stopRelationshipScan(job, status) {
  await chrome.storage.local.set({[relationshipJobKey]: {...job, running: false, status}});
  await chrome.alarms.clear(relationshipAlarm);
  if (job.tabId == null) return;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (relationshipURL(job, tab.url) || tab.pendingUrl === job.url) await chrome.tabs.remove(job.tabId);
  } catch {}
}

async function refreshRelationshipJob(job) {
  job.expires = Date.now() + 5 * minute;
  await chrome.storage.local.set({[relationshipJobKey]: job});
  await chrome.alarms.create(relationshipAlarm, {when: job.expires});
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
  if (saved && snapshot.at <= saved.latest.at) throw new Error('Yeni kaydın tarihi son kayıttan daha yeni olmalı.');
  const changes = relationshipChanges(saved?.latest, snapshot);
  const record = {account, username, latest: snapshot, photos,
    scans: [...(saved?.scans || []), {at: snapshot.at, followers: snapshot.followers.length,
      following: snapshot.following.length, changes: changes.length, source: snapshot.source}],
    events: [...changes, ...(saved?.events || [])]};
  data.accounts = [...data.accounts.filter(item => !sameFollowAccount(item.account, account)), record];
  await chrome.storage.local.set({[relationshipsKey]: data});
  return changes.length;
}

function verifiedRelationshipPhotos(snapshot, photos) {
  if (!photos || typeof photos !== 'object') return {};
  const names = new Set([...snapshot.followers, ...snapshot.following]);
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

async function handleRelationships(message, sender, unfollowSession) {
  if (sender.frameId !== 0) throw new Error('Tarama ana sekmeden başlatılmalı.');
  const job = await relationshipJob();
  if (message.type === 'relationships-resume' && (!job?.running || job.tabId !== sender.tab.id)) return {};
  let account;
  try { account = await senderFollowAccount(sender); }
  catch (error) {
    if (job?.running && job.tabId === sender.tab.id) {
      await stopRelationshipScan(job, 'Instagram hesabı doğrulanamadı. Önceki kayıt korundu.');
    }
    throw error;
  }
  if (message.type === 'relationships-resume') {
    if (!sameFollowAccount(job.account, account) || !relationshipURL(job, sender.url)) {
      await stopRelationshipScan(job, 'Tarama hesabı veya sayfası değişti. Önceki kayıt korundu.');
      return {};
    }
    return {id: job.id};
  }
  const data = (await chrome.storage.local.get(relationshipsKey))[relationshipsKey] || {accounts: []};
  const saved = data.accounts.find(record => sameFollowAccount(record.account, account));
  if (message.type === 'relationships-state') {
    const summary = saved && {account: saved.account, username: saved.username, scans: saved.scans, events: saved.events, latest: {at: saved.latest.at,
      followers: saved.latest.followers.length, following: saved.latest.following.length, source: saved.latest.source}};
    return {account, saved: summary, job: sameFollowAccount(job?.account, account) ? job : null};
  }
  if (message.type === 'relationships-import') {
    if (job?.running) throw new Error('Arşiv yüklemeden önce canlı taramayı durdur.');
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
      status: saved ? 'Arşiv kaydedildi. ' + changes + ' değişiklik bulundu.' : 'İlk arşiv kaydı oluşturuldu.'}});
    return {changes};
  }
  if (message.type === 'relationships-stop') {
    if (job?.running && sameFollowAccount(job.account, account)) await stopRelationshipScan(job, 'Tarama durduruldu. Önceki kayıt korundu.');
    return {};
  }
  if (message.type === 'relationships-start') {
    if (job?.running) throw new Error('Bir tarama zaten çalışıyor.');
    if ((await readFollowQueue()).running || (unfollowSession.owner !== null && await alive(unfollowSession.owner))) {
      throw new Error('Tutarlı bir kayıt için önce takip ve takip bırakma çalışmalarını durdur.');
    }
    const username = normalizeFollowName(message.username || saved?.username || '');
    if (!username) throw new Error('Kendi Instagram kullanıcı adını yaz.');
    const id = crypto.randomUUID();
    const url = 'https://www.instagram.com/' + username + '/?follow_studio_scan=' + id;
    const next = {id, username, account, url, running: true, started: Date.now(), status: 'Profil açılıyor.'};
    try {
      await refreshRelationshipJob(next);
      const tab = await chrome.tabs.create({url, active: false, windowId: sender.tab.windowId});
      next.tabId = tab.id;
      await refreshRelationshipJob(next);
    } catch (error) {
      await stopRelationshipScan(next, 'Tarama sekmesi açılamadı. Önceki kayıt korundu.');
      throw error;
    }
    return {};
  }
  if (!job?.running || job.id !== message.id || job.tabId !== sender.tab.id) throw new Error('Tarama durduruldu.');
  if (!sameFollowAccount(job.account, account)) {
    await stopRelationshipScan(job, 'Instagram hesabı değişti. Önceki kayıt korundu.');
    throw new Error('Tarama hesabı değişti.');
  }
  if (!relationshipURL(job, sender.url)) {
    await stopRelationshipScan(job, 'Tarama profilden başka sayfaya yönlendirildi. Önceki kayıt korundu.');
    throw new Error('Profil adresi değişti.');
  }
  if (message.type === 'relationships-check') {
    await refreshRelationshipJob(job);
    return {username: job.username};
  }
  if (message.type === 'relationships-progress') {
    job.status = message.list === 'followers' ? 'Takipçiler taranıyor.' : 'Takip edilenler taranıyor.';
    if (!Number.isSafeInteger(message.seen) || !Number.isSafeInteger(message.total) ||
        message.seen < 0 || message.seen > message.total) throw new Error('Geçersiz tarama ilerlemesi.');
    job.seen = message.seen;
    job.total = message.total;
    await refreshRelationshipJob(job);
    return {};
  }
  if (message.type === 'relationships-error') {
    const reasons = {
      not_owner: 'Bu profil açık Instagram hesabına ait olarak doğrulanamadı.',
      incomplete: 'Liste tam taranamadı. Eksik liste karşılaştırmaya alınmadı.',
      unavailable: 'Profilde takipçi sayısı var, ancak Instagram listeyi sunmadı. Daha sonra kontrol et veya JSON arşivini kullan.',
      counts_changed: 'Tarama sırasında profil sayıları değişti. Yeniden kontrol et.',
      page: 'Instagram sayfası veya liste yapısı doğrulanamadı.'
    };
    await stopRelationshipScan(job, (reasons[message.code] || reasons.page) + ' Önceki kayıt korundu.');
    return {};
  }
  if (message.type !== 'relationships-result') throw new Error('Desteklenmeyen tarama isteği.');
  if (!validRelationshipList(message.followers, message.counts?.followers) ||
      !validRelationshipList(message.following, message.counts?.following) || message.ownerConfirmed !== true) {
    await stopRelationshipScan(job, 'Liste bütünlüğü doğrulanamadı. Önceki kayıt korundu.');
    throw new Error('Eksik veya geçersiz tarama sonucu.');
  }
  const snapshot = {at: Date.now(), followers: message.followers.slice().sort(),
    following: message.following.slice().sort(), source: 'live'};
  let changes;
  try { changes = await saveRelationshipSnapshot(data, saved, account, job.username, snapshot,
    verifiedRelationshipPhotos(snapshot, message.photos)); }
  catch {
    await stopRelationshipScan(job, 'Kayıt alanına yazılamadı. Önceki kayıt korundu.');
    throw new Error('Tarama kaydedilemedi.');
  }
  await stopRelationshipScan(job, saved ? 'Kontrol tamamlandı. ' + changes.length + ' değişiklik bulundu.' :
    'İlk kayıt oluşturuldu. Sonraki kontrol bu kayıtla karşılaştırılacak.');
  return {};
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== relationshipAlarm) return;
  queueFollowOperation(async () => {
    const job = await relationshipJob();
    if (!job?.running) return;
    if (Date.now() < job.expires) {
      await chrome.alarms.create(relationshipAlarm, {when: job.expires});
      return;
    }
    await stopRelationshipScan(job, 'Tarama ilerlemesi zamanında doğrulanamadı. Önceki kayıt korundu.');
  });
});
chrome.runtime.onStartup.addListener(() => queueFollowOperation(async () => {
  const job = await relationshipJob();
  if (job?.running) await stopRelationshipScan(job, 'Tarayıcı yeniden açıldı. Tarama iptal edildi, önceki kayıt korundu.');
}));
chrome.tabs.onRemoved.addListener(tabId => queueFollowOperation(async () => {
  const job = await relationshipJob();
  if (job?.running && job.tabId === tabId) await stopRelationshipScan(job, 'Tarama sekmesi kapandı. Önceki kayıt korundu.');
}));
chrome.cookies.onChanged.addListener(change => {
  if (change.cookie.name !== 'ds_user_id' || !['instagram.com', '.instagram.com', 'www.instagram.com', '.www.instagram.com'].includes(change.cookie.domain)) return;
  if (change.removed && change.cause === 'overwrite') return;
  queueFollowOperation(async () => {
    const job = await relationshipJob();
    if (job?.running && job.account.storeId === change.cookie.storeId &&
        (change.removed || job.account.id !== change.cookie.value)) {
      await stopRelationshipScan(job, 'Instagram hesabı değişti. Tarama iptal edildi, önceki kayıt korundu.');
    }
  });
});
