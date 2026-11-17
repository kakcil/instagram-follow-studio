'use strict';

const followKey = 'follow-studio-follow-queue';
const followAlarm = 'follow-studio-next-follow';
const defaults = {min: 5, max: 5, batch: 5, rest: 30, limit: 10};
const minute = 60_000;
const reservedProfiles = new Set(['accounts', 'explore', 'direct', 'reels', 'stories', 'p', 'reel', 'about', 'challenge', 'developer']);

async function readFollowQueue() {
  return (await chrome.storage.local.get(followKey))[followKey] ||
    {queue: [], history: [], settings: defaults, running: false, count: 0};
}

const followErrors = {
  page_unavailable: 'Profil sayfası yüklenemedi.',
  button_missing: 'Profilde takip düğmesi bulunamadı.',
  login_required: 'Instagram oturumu açılmalı.',
  challenge_required: 'Instagram hesap doğrulaması istiyor.',
  dialog_blocked: 'Instagram bir iletişim kutusu gösterdi. Sayfayı elle kontrol et.',
  state_unstable: 'Takip düğmesinin durumu sabit kalmadı.',
  rejected: 'İki deneme sonrası düğme hâlâ Takip et durumunda.',
  verification_failed: 'Sayfa yenilendikten sonra takip doğrulanamadı.',
  timeout: 'Profil işlemi zamanında tamamlanamadı.',
  worker_open_failed: 'Arka plan sekmesi başlatılamadı.',
  connection_lost: 'İşlem bağlantısı kesildi.',
  action_blocked: 'Instagram işlem kısıtlaması gösterdi. Sayfayı elle kontrol et.',
  account_changed: 'Instagram hesabı değişti veya doğrulanamadı.'
};

function followAttemptSummary(state, name) {
  const entries = (state.attemptLog || []).filter(entry => entry.name === name);
  return {totalAttempts: entries.length, lastAttemptAt: entries.at(-1)?.time || null};
}

function logFollowFailure(state, code, reason) {
  const name = state.job?.name;
  const entry = {name, code, reason, time: Date.now(), ...followAttemptSummary(state, name)};
  state.failures = [entry, ...(state.failures || [])];
  return entry;
}

async function saveFollowQueue(state) {
  await chrome.storage.local.set({[followKey]: state});
}

function followProfile(url) {
  const match = new URL(url).pathname.match(/^\/([a-z0-9._]{1,30})\/?$/i);
  return match?.[1].toLowerCase();
}

function normalizeFollowName(line) {
  const name = line.trim().replace(/^@/, '');
  if (!/^[a-z0-9._]{1,30}$/i.test(name)) return;
  const normalized = name.toLowerCase();
  if (!reservedProfiles.has(normalized)) return normalized;
}

async function currentFollowAccount(storeId) {
  const cookie = await chrome.cookies.get({url: 'https://www.instagram.com/', name: 'ds_user_id', storeId});
  if (!cookie || !/^[0-9]+$/.test(cookie.value)) throw new Error('Instagram hesabı doğrulanamadı. Oturumunu kontrol et.');
  return {id: cookie.value, storeId: cookie.storeId};
}

function sameFollowAccount(first, second) {
  return first && second && first.id === second.id && first.storeId === second.storeId;
}

async function senderFollowAccount(sender) {
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find(item => item.tabIds.includes(sender.tab.id));
  if (!store) throw new Error('Bu sekmedeki Instagram hesabı doğrulanamadı.');
  return currentFollowAccount(store.id);
}

async function verifyFollowAccount(state, sender) {
  try {
    const account = sender ? await senderFollowAccount(sender) : await currentFollowAccount(state.account?.storeId);
    if (!sameFollowAccount(state.account, account)) throw new Error('Instagram hesabı değişti. Kuyruğun bağlı olduğu hesaba geç.');
    return true;
  } catch (error) {
    await stopFollowQueue(state, error.message + ' Kuyruk durduruldu.', 'account_changed');
    return false;
  }
}

async function closeFollowTab(job) {
  if (job?.tabId == null) return;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (tab.url === job.url || tab.pendingUrl === job.url) await chrome.tabs.remove(tab.id);
  } catch {}
}

async function stopFollowQueue(state, status, code) {
  const job = state.job;
  if (code) logFollowFailure(state, code, status);
  Object.assign(state, {running: false, job: null, next: null, status});
  await saveFollowQueue(state);
  await chrome.alarms.clear(followAlarm);
  await closeFollowTab(job);
}

async function advanceFollowQueue(state, detail = '') {
  state.count = (state.count || 0) + 1;
  if (!state.queue.length) {
    await stopFollowQueue(state, 'Kuyruk tamamlandı. Doğrulanamayan profilleri ayrı listeden inceleyebilirsin.');
    return;
  }
  if (state.count >= (state.settings.limit || defaults.limit)) {
    await stopFollowQueue(state, 'Oturum sınırına ulaşıldı. Kalan liste korundu; otomatik devam edilmeyecek.');
    return;
  }
  const {min, max, batch, rest} = state.settings;
  const pause = state.count % batch === 0;
  state.status = (detail ? detail + ' ' : '') + (pause ? 'Grup molası.' : 'Sıradaki profil bekleniyor.');
  const delay = (min + Math.random() * (max - min) + (pause ? rest : 0)) * minute;
  await scheduleFollow(state, delay);
}

async function holdFailedProfile(state, code, sender) {
  const job = state.job;
  const {name} = job;
  const canSkip = code === 'button_missing' || (!job.attempts && job.phase !== 'verifying' &&
    ['page_unavailable', 'timeout'].includes(code));
  if (canSkip && !await verifyFollowAccount(state, sender)) return;
  const reason = followErrors[code] || 'Takip sonucu doğrulanamadı.';
  const failure = logFollowFailure(state, code, reason);
  state.queue = state.queue.filter(profile => profile !== name);
  state.failed = [{...failure, skipped: canSkip}, ...(state.failed || []).filter(entry => entry.name !== name)];
  if (canSkip) {
    state.job = null;
    await advanceFollowQueue(state, '@' + name + ': Profil atlandı.');
    await closeFollowTab(job);
  } else {
    await stopFollowQueue(state, '@' + name + ': ' + reason + ' Kuyruk durduruldu.');
  }
}

async function scheduleFollow(state, delay) {
  state.next = Date.now() + delay;
  await chrome.alarms.create(followAlarm, {when: state.next});
  await saveFollowQueue(state);
}

async function runFollowAlarm() {
  const state = await readFollowQueue();
  if (!state.running || !state.next) return;
  if (Date.now() < state.next) {
    await chrome.alarms.create(followAlarm, {when: state.next});
    return;
  }
  if (state.job) {
    await holdFailedProfile(state, 'timeout');
    return;
  }

  if (!await verifyFollowAccount(state)) return;
  const name = state.queue[0];
  if (!name) {
    await stopFollowQueue(state, 'Kuyruk tamamlandı.');
    return;
  }
  const id = crypto.randomUUID();
  const url = 'https://www.instagram.com/' + name + '/?follow_studio_job=' + id;
  state.job = {id, name, url};
  state.status = '@' + name + ' kontrol ediliyor.';
  try {
    await scheduleFollow(state, 90_000);
    const tab = await chrome.tabs.create({url, active: false, windowId: state.windowId});
    state.job.tabId = tab.id;
    await saveFollowQueue(state);
  } catch {
    await stopFollowQueue(state, 'Arka plan sekmesi başlatılamadı.', 'worker_open_failed');
  }
}

async function handleFollow(message, sender, unfollowSession) {
  if (sender.frameId !== 0) throw new Error('İşlem ana sayfadan yapılmalı.');
  const state = await readFollowQueue();
  const job = state.job;

  switch (message.type) {
    case 'follow-add': {
      const name = followProfile(sender.url);
      if (!name || reservedProfiles.has(name)) {
        throw new Error('Önce bir Instagram profili aç.');
      }
      if (state.failed?.some(entry => entry.name === name)) {
        throw new Error('Bu profil doğrulanamayanlar listesinde. Yeniden denemek için oradan kuyruğa al.');
      }
      if (state.history.some(entry => entry.name === name)) {
        throw new Error('@' + name + ': Bu hesap daha önce tamamlandı veya takip isteği gönderildi.');
      }
      if (state.queue.includes(name)) return {status: '@' + name + ' zaten kuyrukta.'};
      state.queue.push(name);
      await saveFollowQueue(state);
      return {status: '@' + name + ' kuyruğa eklendi.'};
    }
    case 'follow-export': {
      if (state.running) await stopFollowQueue(state, 'Liste aktarımı için çalışma durduruldu.');
      return {text: [...new Set(state.queue)].map(name => '@' + name).join('\n'), count: new Set(state.queue).size};
    }
    case 'follow-add-list': {
      if (typeof message.text !== 'string') throw new Error('Her satıra bir kullanıcı adı yaz.');
      const queued = new Set(state.queue);
      const held = new Set((state.failed || []).map(entry => entry.name));
      const completed = new Set(state.history.map(entry => entry.name));
      const counts = {added: 0, duplicate: 0, held: 0, completed: 0, invalid: 0};
      for (const line of message.text.split(/\r\n?|\n/)) {
        if (!line.trim()) continue;
        const name = normalizeFollowName(line);
        if (!name) counts.invalid++;
        else if (held.has(name)) counts.held++;
        else if (queued.has(name)) counts.duplicate++;
        else if (completed.has(name)) counts.completed++;
        else {
          queued.add(name);
          state.queue.push(name);
          counts.added++;
        }
      }
      if (counts.added) await saveFollowQueue(state);
      return {counts};
    }
    case 'follow-remove':
      if (job?.name === message.name) throw new Error('Bu profil işleniyor. Önce kuyruğu durdur.');
      state.queue = state.queue.filter(name => name !== message.name);
      if (state.running && !state.queue.length) await stopFollowQueue(state, 'Kuyruk boş.');
      else await saveFollowQueue(state);
      return {};
    case 'follow-requeue': {
      if (state.running) throw new Error('Profili yeniden kuyruğa almak için çalışmayı durdur.');
      const name = message.name;
      if (!state.failed?.some(entry => entry.name === name)) throw new Error('Profil doğrulanamayanlar listesinde bulunamadı.');
      state.failed = state.failed.filter(entry => entry.name !== name);
      if (!state.queue.includes(name)) state.queue.push(name);
      state.status = '@' + name + ' yeniden kuyruğa alındı.';
      await saveFollowQueue(state);
      return {};
    }
    case 'follow-start': {
      if ((await relationshipJob())?.running) throw new Error('Önce takipleşme taramasını durdur.');
      if ((await readDmQueue())?.running) throw new Error('Önce mesaj işlemini durdur.');
      if (state.running) return {};
      if (unfollowSession.owner !== null && await alive(unfollowSession.owner)) throw new Error('Takip bırakma çalışmasını önce durdur.');
      if (!state.queue.length) throw new Error('Kuyruk boş.');
      const account = await senderFollowAccount(sender);
      if (state.account && !sameFollowAccount(state.account, account)) {
        throw new Error('Bu kuyruk başka bir Instagram hesabına bağlı. Kuyruğun hesabına geç.');
      }
      const {min, max, batch, rest} = message.settings || {};
      const limit = message.settings?.limit ?? defaults.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Oturum sınırı 1–50 profil olmalı.');
      if (![min, max, batch, rest].every(n => Number.isInteger(n) && n >= 1 && n <= 1440) || min > max) {
        throw new Error('Ayarları kontrol et. En kısa aralık, en uzun aralıktan büyük olamaz.');
      }
      Object.assign(state, {account, windowId: sender.tab.windowId, settings: {min, max, batch, rest, limit}, timingVersion: 1, count: 0, running: true, status: 'İlk profil bekleniyor.'});
      await scheduleFollow(state, 1000);
      return {};
    }
    case 'follow-stop':
      await stopFollowQueue(state, 'Kuyruk durduruldu.');
      return {};
    case 'follow-verify':
    case 'follow-attempt':
    case 'follow-check':
    case 'follow-result': {
      const senderUrl = new URL(sender.url);
      if (!state.running || !job || job.id !== message.id || job.tabId !== sender.tab.id) {
        throw new Error('Takip işlemi artık etkin değil.');
      }
      if (message.type === 'follow-result' && !['followed', 'requested', 'already'].includes(message.outcome)) {
        const code = Object.hasOwn(followErrors, message.code) ? message.code
          : message.outcome === 'follow' ? 'rejected' : 'connection_lost';
        await holdFailedProfile(state, code, sender);
        return {};
      }
      if (followProfile(sender.url) !== job.name || senderUrl.searchParams.get('follow_studio_job') !== job.id) {
        throw new Error('İşlem profilinden başka bir sayfaya geçildi.');
      }
      if (!await verifyFollowAccount(state, sender)) throw new Error(state.status);
      if (message.type === 'follow-verify') {
        if (!['followed', 'requested', 'already'].includes(message.outcome) || job.phase === 'verifying' || !sender.documentId) {
          throw new Error('Doğrulama isteği geçersiz.');
        }
        job.phase = 'verifying';
        job.expected = message.outcome;
        job.originalDocument = sender.documentId;
        state.status = '@' + job.name + ': sayfa yenilenerek doğrulanıyor.';
        await scheduleFollow(state, 90_000);
        try { await chrome.tabs.reload(job.tabId); }
        catch { await holdFailedProfile(state, 'verification_failed'); }
        return {};
      }
      if (message.type === 'follow-attempt') {
        if (job.phase === 'verifying') throw new Error('Doğrulama aşamasında tekrar takip yapılamaz.');
        if ((job.attempts || 0) >= 2 || (job.lastAttemptAt && Date.now() - job.lastAttemptAt < 3000)) {
          throw new Error('Bu profil için deneme sınırına ulaşıldı.');
        }
        job.attempts = (job.attempts || 0) + 1;
        job.lastAttemptAt = Date.now();
        state.attemptLog = [...(state.attemptLog || []), {name: job.name, time: job.lastAttemptAt, jobId: job.id, attempt: job.attempts}];
        await saveFollowQueue(state);
        return {name: job.name, attempts: job.attempts};
      }
      if (message.type === 'follow-check') {
        if (job.phase === 'verifying' && sender.documentId && sender.documentId !== job.originalDocument) {
          job.verificationDocument = sender.documentId;
          await saveFollowQueue(state);
        }
        return {name: job.name, attempts: job.attempts || 0, phase: job.phase, expected: job.expected};
      }
      if (job.phase !== 'verifying' || !job.verificationDocument || job.verificationDocument !== sender.documentId ||
          sender.documentId === job.originalDocument) throw new Error('Takip sayfa yenilenerek henüz doğrulanmadı.');
      const outcome = job.expected === 'already' && message.outcome === 'followed' ? 'already' : message.outcome;
      state.queue = state.queue.filter(name => name !== job.name);
      state.history.unshift({name: job.name, outcome, time: Date.now(), ...followAttemptSummary(state, job.name)});
      state.job = null;
      await advanceFollowQueue(state);
      await closeFollowTab(job);
      return {};
    }
    default:
      throw new Error('Desteklenmeyen takip isteği.');
  }
}

function queueFollowOperation(operation) {
  operations = operations.then(operation).catch(error => console.error('Follow Studio:', error.message));
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === followAlarm) queueFollowOperation(runFollowAlarm);
});
chrome.runtime.onStartup.addListener(() => queueFollowOperation(async () => {
  const state = await readFollowQueue();
  if (state.running) await stopFollowQueue(state, 'Chrome yeniden açıldı. Devam etmek için Başlat’a bas.');
}));

chrome.cookies.onChanged.addListener(change => {
  const {cookie, removed, cause} = change;
  if (cookie.name !== 'ds_user_id' || !['instagram.com', '.instagram.com', 'www.instagram.com', '.www.instagram.com'].includes(cookie.domain)) return;
  // An overwrite emits removal before insertion. Compare the inserted identity.
  if (removed && cause === 'overwrite') return;
  queueFollowOperation(async () => {
    const state = await readFollowQueue();
    if (!state.running || state.account?.storeId !== cookie.storeId) return;
    if (removed || cookie.value !== state.account.id) {
      await stopFollowQueue(state, 'Instagram hesabı değişti veya oturum kapandı. Kuyruk durduruldu.', 'account_changed');
    }
  });
});
