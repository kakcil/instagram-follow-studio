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
  const path = job.thread ? '/direct/t/' + job.thread + '/' : '/direct/inbox/';
  return 'https://www.instagram.com' + path + '?follow_studio_dm_job=' + job.id;
}

async function saveDmQueue(job) {
  await chrome.storage.local.set({[dmQueueKey]: job});
}

async function refreshDmTimeout() {
  await chrome.alarms.create(dmAlarm, {when: Date.now() + 2 * minute});
}

function dmBounds(window) {
  return {left: window.left, top: window.top, width: window.width, height: window.height};
}

async function dmWorkLayout(windowId) {
  if (!Number.isInteger(windowId)) return null;
  const window = await chrome.windows.get(windowId);
  if (window.type !== 'normal' || !['normal', 'maximized'].includes(window.state)) return null;
  const original = dmBounds(window);
  if (!Object.values(original).every(Number.isInteger) || original.width < 1160) return null;
  const workerWidth = Math.max(620, Math.round(original.width * 0.43));
  const main = {...original, width: original.width - workerWidth};
  const worker = {...original, left: original.left + main.width, width: workerWidth};
  return {windowId, state: window.state, original, main, worker};
}

async function restoreDmLayout(layout) {
  if (!layout) return;
  try {
    const current = await chrome.windows.get(layout.windowId);
    // Leave any manual move or resize made during the run in place.
    if (current.state !== 'normal' || Object.entries(layout.main)
      .some(([key, value]) => Math.abs(current[key] - value) > 12)) return;
    if (layout.state === 'maximized') await chrome.windows.update(layout.windowId, {state: 'maximized'});
    else await chrome.windows.update(layout.windowId, layout.original);
  } catch {}
}

async function finishDmQueue(job, status, {keepTab = false} = {}) {
  const tabId = job.tabId;
  await saveDmQueue({...job, running: false, status, tabId: null, documentId: null,
    reviewTabId: keepTab ? tabId : null});
  await chrome.alarms.clear(dmAlarm);
  await restoreDmLayout(job.layout);
  if (tabId == null || keepTab) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url === dmWorkerURL(job) || tab.pendingUrl === dmWorkerURL(job) ||
        (job.thread && dmThread(tab.url) === job.thread)) {
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
    // The worker is the selected tab of a separate window, so selecting
    // another tab in the user's main window does not deactivate it.
    const workerWindow = await chrome.windows.create({
      url: dmWorkerURL(job), type: 'popup', focused: false,
      ...(job.layout?.worker || {width: 1100, height: 850})
    });
    tab = workerWindow?.tabs?.[0];
    if (tab?.id == null && workerWindow?.id != null) {
      [tab] = await chrome.tabs.query({windowId: workerWindow.id, active: true});
    }
    if (tab?.id == null) throw new Error('Missing message worker tab');
    try { await chrome.tabs.update(tab.id, {autoDiscardable: false}); } catch {}
    await saveDmQueue({...job, tabId: tab.id, documentId: null});
  } catch {
    await finishDmQueue({...job, tabId: tab?.id}, 'Mesaj işlemi durdu: arka plan sekmesi açılamadı.');
  }
}

const dmStopReasons = {
  restricted: 'Mesaj işlemi durdu: Instagram bir kısıtlama gösterdi.',
  recipient: 'Mesaj işlemi durdu: hedef kullanıcıya ait bire bir sohbet doğrulanamadı.',
  popup: 'Mesaj işlemi durdu: küçük sohbet penceresinden tam sohbete geçilemedi.',
  search: 'Mesaj işlemi durdu: Mesajlar aramasında kullanıcı adına ait tek bir sohbet bulunamadı.',
  history: 'En eski mesaj doğrulanamadı. Tarama tamamlanmadı; çalışma penceresi açık bırakıldı.',
  list: 'Mesaj işlemi durdu: Instagram mesaj listesini yüklemedi.',
  overlay: 'Mesaj işlemi durdu: Instagram’da açık bir pencere mesaj menüsünü engelliyor.',
  reaction: 'Mesaj işlemi durdu: Instagram tepki listesi doğrulanamadı.',
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
    return {job: sameAccount ? {username: job.username, running: job.running, count: job.count, status: job.status,
      reactions: job.options?.reactions ? job.reactions : undefined, canShow: job.tabId != null || job.reviewTabId != null} : null};
  }
  if (message.type === 'dm-show') {
    const target = job?.tabId ?? job?.reviewTabId;
    if (!sameAccount || target == null) return {};
    const tab = await chrome.tabs.get(target);
    const url = tab.pendingUrl || tab.url;
    if (url === dmWorkerURL(job) || (job.thread && dmThread(url) === job.thread)) {
      await chrome.windows.update(tab.windowId, {focused: true});
    }
    return {};
  }
  if (message.type === 'dm-stop') {
    if (job?.running && sameAccount) {
      await finishDmQueue(job, job.pending ? dmStopReasons.uncertain : 'Mesaj işlemi durduruldu.');
    }
    return {};
  }
  if (message.type === 'dm-start') {
    const username = typeof message.username === 'string' && normalizeFollowName(message.username);
    const preview = message.preview === true;
    const options = {messages: message.confirmed === true || (preview && message.removeReactions !== true),
      reactions: message.removeReactions === true};
    if (!username || (!options.messages && !options.reactions)) {
      throw new Error('Bir Instagram kullanıcı adı yaz ve geri alma işlemini onayla.');
    }
    if (job?.running) throw new Error('Bir mesaj işlemi zaten çalışıyor.');
    if ((await readFollowQueue()).running || (unfollowSession.owner !== null && await alive(unfollowSession.owner))) {
      throw new Error('Önce takip veya takipten çıkma kuyruğunu durdur.');
    }
    let layout;
    try { layout = await dmWorkLayout(sender.tab.windowId); } catch {}
    const next = {id: crypto.randomUUID(), account, username, preview, options, thread: null, running: true, count: 0, reactions: 0, layout,
      pending: false, tabId: null, status: 'Mesaj işlemi arka planda çalışıyor.'};
    await saveDmQueue(next);
    if (layout) {
      try {
        if (layout.state === 'maximized') await chrome.windows.update(layout.windowId, {state: 'normal'});
        await chrome.windows.update(layout.windowId, layout.main);
      } catch {
        try {
          if (layout.state === 'maximized') await chrome.windows.update(layout.windowId, {state: 'maximized'});
          else await chrome.windows.update(layout.windowId, layout.original);
        } catch {}
        next.layout = null;
        await saveDmQueue(next);
      }
    }
    await openDmWorker(next);
    return {};
  }

  if (!job?.running || job.tabId !== tabId ||
      (message.type !== 'dm-resume' && job.id !== message.id)) throw new Error('Mesaj işlemi durduruldu.');
  if (!sameAccount) {
    await finishDmQueue(job, 'Mesaj işlemi durdu: Instagram hesabı değişti.');
    throw new Error('Mesaj işlemi durduruldu.');
  }
  if (message.type === 'dm-delay') {
    if (job.documentId && job.documentId !== sender.documentId) throw new Error('Mesaj işlemi durduruldu.');
    if (!Number.isInteger(message.ms) || message.ms < 1 || message.ms > 1500) throw new Error('Geçersiz bekleme süresi.');
    await new Promise(resolve => setTimeout(resolve, message.ms));
    return {};
  }
  if (message.type === 'dm-resume') {
    if (!job.thread) {
      if (sender.url === dmWorkerURL(job) || dmThread(sender.url)) {
        await refreshDmTimeout();
        return {id: job.id, username: job.username};
      }
      return {};
    }
    if (dmThread(sender.url) !== job.thread) throw new Error('Mesaj işlemi durduruldu.');
    if (job.pending) {
      await finishDmQueue(job, dmStopReasons.uncertain);
      return {};
    }
    if (job.documentId === sender.documentId) return {};
    await saveDmQueue({...job, documentId: sender.documentId});
    await refreshDmTimeout();
    return {id: job.id, thread: job.thread, preview: job.preview, username: job.username, options: job.options};
  }
  // A SPA transition may leave sender.url at the profile where the content
  // script was injected. The registered tab's current URL is authoritative.
  const currentThread = dmThread((await chrome.tabs.get(tabId)).url || sender.url);
  if (message.type === 'dm-bind' && !job.thread) {
    if (!currentThread || !sender.documentId || job.username !== message.username) throw new Error(dmStopReasons.recipient);
    await saveDmQueue({...job, thread: currentThread, documentId: sender.documentId});
    await refreshDmTimeout();
    return {thread: currentThread, preview: job.preview, options: job.options};
  }
  if (message.type === 'dm-resolve-error' && !job.thread) {
    const reason = ['restricted', 'search'].includes(message.reason) ? message.reason : 'recipient';
    await finishDmQueue(job, dmStopReasons[reason]);
    return {};
  }
  if (!job.thread || currentThread !== job.thread) throw new Error('Mesaj işlemi durduruldu.');
  if (!job.documentId || job.documentId !== sender.documentId) throw new Error('Mesaj işlemi durduruldu.');
  switch (message.type) {
    case 'dm-check':
      await refreshDmTimeout();
      return {};
    case 'dm-commit':
      if (job.preview) throw new Error('Sohbet kontrolü sırasında mesaj geri alınamaz.');
      if (job.pending) throw new Error(dmStopReasons.uncertain);
      {
        const operation = message.operation || 'message';
        const options = job.options || {messages: true};
        if (!(operation === 'message' && options.messages) && !(operation === 'reaction' && options.reactions)) {
          throw new Error('Bu işleme izin verilmedi.');
        }
        await saveDmQueue({...job, pending: true, operation});
      }
      await refreshDmTimeout();
      return {};
    case 'dm-removed':
      if (!job.pending) throw new Error(dmStopReasons.uncertain);
      await saveDmQueue({...job, pending: false, operation: null,
        count: job.count + (job.operation === 'reaction' ? 0 : 1),
        reactions: (job.reactions || 0) + (job.operation === 'reaction' ? 1 : 0)});
      await refreshDmTimeout();
      return {};
    case 'dm-finish':
      if (job.preview && !message.reason) {
        const status = message.reactionVerified === true ? 'Kendi tepkinin kaldırma seçeneği doğrulandı. Tepki kaldırılmadı.' :
          job.options?.reactions ? 'Sohbet tarandı. Kaldırılabilecek kendi tepkin bulunamadı.' :
          message.menuVerified === true ? 'Gönderdiğin bir mesajda Geri Al menüsü doğrulandı. Mesajlara dokunulmadı.' :
          message.skipped > 0 ? 'Gönderdiğin mesaj bulundu ancak Geri Al menüsü doğrulanamadı.' :
          message.scrolled === true ? 'Sohbet tarandı. Gönderdiğin bir mesaj bulunamadı.' :
          'Sohbet doğrulandı. Daha eski mesajlara kaydırılamadı.';
        await finishDmQueue(job, status);
        return {};
      }
      {
        const error = job.pending || Object.hasOwn(dmStopReasons, message.reason);
        const skipped = Number.isSafeInteger(message.skipped) && message.skipped > 0 ? message.skipped : 0;
        const status = job.pending ? dmStopReasons.uncertain : error ? dmStopReasons[message.reason] :
          skipped ? skipped + ' mesaj geri alınamadı. Diğer mesajların taraması tamamlandı.' : 'Mesaj işlemi tamamlandı.';
        const keepTab = message.reason === 'history' || (!job.preview && Boolean(error || skipped));
        await finishDmQueue(job, status, {keepTab});
      }
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
    if (job?.running && job.tabId === tabId && job.thread && dmThread(change.url) !== job.thread) {
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
    await finishDmQueue(job, job.pending ? dmStopReasons.uncertain : 'Mesaj işlemi durdu: Instagram yanıt vermedi.', {keepTab: Boolean(job.thread)});
  });
});

chrome.runtime.onStartup.addListener(() => queueFollowOperation(async () => {
  const job = await readDmQueue();
  if (job?.running) await finishDmQueue(job, job.pending ? dmStopReasons.uncertain : 'Mesaj işlemi durdu: tarayıcı yeniden açıldı.');
}));
