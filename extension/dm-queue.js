'use strict';

const dmQueueKey = 'follow-studio-dm-queue';
const dmAlarm = 'follow-studio-dm-timeout';

async function readDmQueue() {
  return (await chrome.storage.local.get(dmQueueKey))[dmQueueKey];
}

function dmThread(url) {
  if (!instagram(url)) return null;
  return new URL(url).pathname.match(/^\/direct\/t\/(\d+)\/?$/)?.[1] || null;
}

function dmWorkerURL(job) {
  return 'https://www.instagram.com/direct/t/' + job.thread + '/?follow_studio_dm_job=' + job.id;
}

async function saveDmQueue(job) {
  await chrome.storage.local.set({[dmQueueKey]: job});
}

async function refreshDmTimeout() {
  await chrome.alarms.create(dmAlarm, {when: Date.now() + 2 * minute});
}

async function finishDmQueue(job, status) {
  const tabId = job.tabId;
  await saveDmQueue({...job, running: false, status, tabId: null, documentId: null});
  await chrome.alarms.clear(dmAlarm);
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (dmThread(tab.url) === job.thread || tab.pendingUrl === dmWorkerURL(job)) {
      await chrome.tabs.remove(tabId);
    }
  } catch {}
}

async function openDmWorker(job) {
  let tab;
  try {
    if (!sameFollowAccount(job.account, await currentFollowAccount(job.account.storeId))) {
      await finishDmQueue(job, 'Mesaj işlemi durdu: Instagram hesabı değişti.');
      return;
    }
    await refreshDmTimeout();
    const options = {url: dmWorkerURL(job), active: false};
    if (Number.isInteger(job.windowId)) options.windowId = job.windowId;
    tab = await chrome.tabs.create(options);
    await saveDmQueue({...job, tabId: tab.id, documentId: null});
  } catch {
    await finishDmQueue({...job, tabId: tab?.id}, 'Mesaj işlemi durdu: arka plan sekmesi açılamadı.');
  }
}

const dmStopReasons = {
  restricted: 'Mesaj işlemi durdu: Instagram bir kısıtlama gösterdi.',
  menu: 'Mesaj işlemi durdu: mesajın üç nokta menüsünde Geri al bulunamadı.',
  unsupported: 'Mesaj işlemi durdu: Instagram’ın mesaj kontrolleri doğrulanamadı.',
  uncertain: 'Mesaj işlemi durdu: son geri alma işleminin sonucu belirsiz.'
};

async function handleDm(message, sender, unfollowSession) {
  if (sender.frameId !== 0) throw new Error('İşlem ana sekmeden başlatılmalı.');
  const job = await readDmQueue();
  const tabId = sender.tab.id;
  if (message.type === 'dm-resume' && (!job?.running || job.tabId !== tabId)) return {};
  let account;
  try {
    account = await senderFollowAccount(sender);
  } catch (error) {
    if (job?.running && job.tabId === tabId) await finishDmQueue(job, 'Mesaj işlemi durdu: Instagram hesabı değişti.');
    throw error;
  }
  const sameAccount = sameFollowAccount(job?.account, account);
  if (message.type === 'dm-state') {
    return {job: sameAccount ? {thread: job.thread, running: job.running, count: job.count, status: job.status} : null};
  }
  if (message.type === 'dm-stop') {
    if (job?.running && sameAccount) {
      await finishDmQueue(job, job.pending ? dmStopReasons.uncertain : 'Mesaj işlemi durduruldu.');
    }
    return {};
  }
  if (message.type === 'dm-start') {
    const thread = dmThread(sender.url);
    if (!thread || message.confirmed !== true) throw new Error('Bir Instagram sohbeti açıp geri alma işlemini onayla.');
    if (job?.running) throw new Error('Bir mesaj işlemi zaten çalışıyor.');
    if ((await readFollowQueue()).running || (unfollowSession.owner !== null && await alive(unfollowSession.owner))) {
      throw new Error('Önce takip veya takipten çıkma kuyruğunu durdur.');
    }
    const next = {id: crypto.randomUUID(), account, thread, windowId: sender.tab.windowId, running: true, count: 0,
      pending: false, tabId: null, status: 'Mesaj işlemi arka planda çalışıyor.'};
    await saveDmQueue(next);
    await openDmWorker(next);
    return {};
  }

  if (!job?.running || job.tabId !== tabId || dmThread(sender.url) !== job.thread ||
      (message.type !== 'dm-resume' && job.id !== message.id)) throw new Error('Mesaj işlemi durduruldu.');
  if (!sameAccount) {
    await finishDmQueue(job, 'Mesaj işlemi durdu: Instagram hesabı değişti.');
    throw new Error('Mesaj işlemi durduruldu.');
  }
  if (message.type === 'dm-resume') {
    if (job.pending) {
      await finishDmQueue(job, dmStopReasons.uncertain);
      return {};
    }
    if (job.documentId === sender.documentId) return {};
    await saveDmQueue({...job, documentId: sender.documentId});
    await refreshDmTimeout();
    return {id: job.id, thread: job.thread};
  }
  if (!job.documentId || job.documentId !== sender.documentId) throw new Error('Mesaj işlemi durduruldu.');
  switch (message.type) {
    case 'dm-check':
      await refreshDmTimeout();
      return {};
    case 'dm-commit':
      if (job.pending) throw new Error(dmStopReasons.uncertain);
      await saveDmQueue({...job, pending: true});
      await refreshDmTimeout();
      return {};
    case 'dm-removed':
      if (!job.pending) throw new Error(dmStopReasons.uncertain);
      await saveDmQueue({...job, pending: false, count: job.count + 1});
      await refreshDmTimeout();
      return {};
    case 'dm-finish':
      await finishDmQueue(job, job.pending ? dmStopReasons.uncertain :
        (Object.hasOwn(dmStopReasons, message.reason) ? dmStopReasons[message.reason] : 'Mesaj işlemi tamamlandı.'));
      return {};
    default:
      throw new Error('Desteklenmeyen istek.');
  }
}

chrome.tabs.onRemoved.addListener((tabId, info) => queueFollowOperation(async () => {
  const job = await readDmQueue();
  if (!job?.running || job.tabId !== tabId) return;
  if (job.pending || info?.isWindowClosing) {
    await finishDmQueue(job, job.pending ? dmStopReasons.uncertain : 'Mesaj işlemi durduruldu.');
    return;
  }
  await openDmWorker({...job, tabId: null, documentId: null});
}));

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  queueFollowOperation(async () => {
    const job = await readDmQueue();
    if (job?.running && job.tabId === tabId && dmThread(change.url) !== job.thread) {
      await finishDmQueue(job, 'Mesaj işlemi durdu: sohbet sayfası değişti.');
    }
  });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== dmAlarm) return;
  queueFollowOperation(async () => {
    const job = await readDmQueue();
    if (!job?.running) return;
    if (!job.pending && (job.tabId == null || !await alive(job.tabId))) {
      await openDmWorker({...job, tabId: null, documentId: null});
      return;
    }
    await finishDmQueue(job, job.pending ? dmStopReasons.uncertain : 'Mesaj işlemi durdu: Instagram yanıt vermedi.');
  });
});

chrome.runtime.onStartup.addListener(() => queueFollowOperation(async () => {
  const job = await readDmQueue();
  if (job?.running) await finishDmQueue(job, job.pending ? dmStopReasons.uncertain : 'Mesaj işlemi durdu: tarayıcı yeniden açıldı.');
}));
