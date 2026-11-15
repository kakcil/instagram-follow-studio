/* Native Chrome storage and messaging; no userscript manager required. */
globalThis.FollowStudioBridge = {
  async connect() {
    const keys = new Set(['local-unfollow-job', 'follow-studio-cache', 'follow-studio-protected',
      'follow-studio-frozen', 'follow-studio-run-summary', 'follow-studio-mode', 'follow-studio-order']);
    const snapshot = await chrome.storage.local.get([...keys]);
    let writes = Promise.resolve();
    let writeError = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const [key, change] of Object.entries(changes)) {
        if (!keys.has(key)) continue;
        if ('newValue' in change) snapshot[key] = structuredClone(change.newValue);
        else delete snapshot[key];
      }
    });
    const queue = operation => {
      writes = writes.then(operation).catch(error => { writeError = error; });
    };
    const message = async data => {
      const response = await chrome.runtime.sendMessage(data);
      if (!response || !response.ok) throw Object.assign(new Error(response?.error || 'Eklenti bağlantısı kurulamadı.'), {outcome: response?.outcome});
      return response;
    };
    const flush = async () => {
      await writes;
      if (writeError) throw new Error('Liste kaydedilemedi; işlem yapılmadı: ' + writeError.message);
    };
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === 'studio-open') {
        const panel = document.querySelector('#ig-follow-manager')?.shadowRoot;
        if (panel?.querySelector('[data-veil]').hidden) panel.querySelector('[data-open]').click();
      }
    });
    return {
      getValue(key, fallback) {
        return structuredClone(Object.prototype.hasOwnProperty.call(snapshot, key) ? snapshot[key] : fallback);
      },
      setValue(key, value) {
        const copy = structuredClone(value);
        snapshot[key] = copy;
        queue(() => chrome.storage.local.set({[key]: copy}));
      },
      deleteValue(key) {
        delete snapshot[key];
        queue(() => chrome.storage.local.remove(key));
      },
      flush,
      async claim() { await flush(); return (await message({type: 'studio-claim'})).claimed; },
      async release() { await writes; await message({type: 'studio-release'}); await flush(); },
      async verifyCandidate(username) {
        await message({type: 'studio-verify-candidate', username});
      },
      async checkJob(username, id) {
        await flush();
        return (await message({type: 'studio-check', username, id})).job;
      },
      async openTab(url) {
        await flush();
        const {tabId} = await message({type: 'studio-open-worker', url});
        return {close: () => message({type: 'studio-close-worker', tabId})};
      },
      async ready() { return (await message({type: 'studio-ready'})).open; },
      async profileDetails() { return message({type: 'studio-profile-details'}); }
    };
  }
};
