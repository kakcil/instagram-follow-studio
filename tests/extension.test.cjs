const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {randomUUID} = require('node:crypto');
const root = path.join(__dirname, '../extension');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const {zipJson} = require('./zip-fixture.cjs');
const jobKey = 'local-unfollow-job';
const cacheKey = 'follow-studio-cache';
const relationshipsKey = 'follow-studio-relationships';

function unfollowRelationshipFixture({at = Date.now(), source = 'live', followers = [],
  following = ['fixture_candidate']} = {}) {
  return {accounts: [{account: {id: '1001', storeId: '0'}, latest: {at, source, followers, following}}]};
}

function environment(initial = {}, browserWindow) {
  const local = structuredClone(initial), session = {}, changes = [];
  const tabs = new Map([[1, {id: 1}], [2, {id: 2}]]), removed = [], updated = [];
  const documents = new Map();
  const windows = [], backgroundDelays = [];
  if (browserWindow) {
    windows.push({...browserWindow});
    tabs.get(1).windowId = browserWindow.id;
  }
  let listener, created, next = 10;
  const event = list => ({addListener(fn) { list.push(fn); }});
  const area = (data, name) => ({
    async get(keys) {
      if (keys === null) return structuredClone(data);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])]));
    },
    async set(values) {
      const delta = {};
      for (const [key, value] of Object.entries(values)) { data[key] = structuredClone(value); delta[key] = {newValue: structuredClone(value)}; }
      for (const fn of changes) fn(delta, name);
    },
    async remove(key) { delete data[key]; for (const fn of changes) fn({[key]: {}}, name); }
  });
  const storage = {local: area(local, 'local'), session: area(session, 'session'), onChanged: event(changes)};
  const powerCalls = [];
  const chrome = {
    power: {
      requestKeepAwake(level) { powerCalls.push(level); },
      releaseKeepAwake() { powerCalls.push('release'); }
    },
    storage, runtime: {id: 'fixture-extension', onMessage: {addListener(fn) { listener = fn; }}},
    action: {onClicked: {addListener() {}}},
    windows: {
      async get(id) {
        const window = windows.find(item => item.id === id);
        if (!window) throw new Error('Missing window');
        return {...window};
      },
      async create(options) {
        const window = {id: 100 + windows.length, ...options};
        windows.push(window);
        const tab = await chrome.tabs.create({url: options.url, active: true, windowId: window.id});
        return {...window, tabs: [tab]};
      },
      async update(id, options) {
        const window = windows.find(item => item.id === id);
        if (!window) throw new Error('Missing window');
        return Object.assign(window, options);
      }
    },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('Missing tab'); return tabs.get(id); },
      async create(options) { const tab = {id: next++, ...options}; tabs.set(tab.id, tab); created?.(tab); return tab; },
      async remove(id) { tabs.delete(id); },
      async update(id, values) { return Object.assign(await this.get(id), values); },
      async reload(id) { documents.set(id, (documents.get(id) || 0) + 1); },
      onRemoved: event(removed), onUpdated: event(updated)
    }
  };
  const cookieChanges = [];
  let accountId = '1001';
  let cookieStoreId = '0';
  chrome.cookies = {
    onChanged: event(cookieChanges),
    async get({storeId}) {
      return accountId === null ? null : {name: 'ds_user_id', value: accountId, storeId: storeId || '0'};
    },
    async getAllCookieStores() { return [{id: cookieStoreId, tabIds: [...tabs.keys()]}]; }
  };
  const alarms = [];
  chrome.alarms = {onAlarm: event(alarms), async create() {}, async clear() {}};
  chrome.runtime.onStartup = {addListener() {}};
  const context = vm.createContext({chrome, URL, console, crypto: {randomUUID},
    setTimeout(fn, ms) { backgroundDelays.push(ms); return setImmediate(fn); }});
  context.importScripts = filename => vm.runInContext(read(filename), context);
  vm.runInContext(read('background.js'), context);
  const send = (message, tabId = 1, frameId = 0, url = 'https://www.instagram.com/') => new Promise(resolve => {
    listener(message, {id: chrome.runtime.id, tab: {id: tabId, windowId: tabs.get(tabId)?.windowId},
      frameId, url, documentId: 'document-' + tabId + '-' + (documents.get(tabId) || 0)}, resolve);
  });
  return {local, session, storage, send, tabs, updated, removed, alarms, powerCalls, windows, backgroundDelays,
    flushPower: () => vm.runInContext('powerUpdates', context),
    setStore(value) { cookieStoreId = value; },
    setAccount(value, notify = false) {
      accountId = value;
      if (notify) cookieChanges.forEach(listener => listener({
        cookie: {name: 'ds_user_id', value: value || '', storeId: '0', domain: '.instagram.com'},
        removed: value === null, cause: 'explicit'
      }));
    }, onCreated(fn) { created = fn; }};
}

async function app(env, url = 'https://www.instagram.com/', tabId = 1, language = 'tr') {
  const dom = new JSDOM(`<html lang="${language}"><body></body></html>`, {url, runScripts: 'outside-only', pretendToBeVisual: true});
  const w = dom.window;
  w.structuredClone = structuredClone; w.TextDecoder = TextDecoder; w.crypto.randomUUID = randomUUID;
  w.chrome = {storage: env.storage, runtime: {
    sendMessage: message => env.send(message, tabId, 0, url), onMessage: {addListener() {}}
  }};
  const scripts = JSON.parse(read('manifest.json')).content_scripts[0].js;
  for (const filename of scripts) await w.eval(read(filename));
  return {dom, w, panel: w.document.querySelector('#ig-follow-manager')?.shadowRoot};
}

test('follow power is restored on worker wake and released for every stopped state', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment({[key]: {running: true, queue: ['candidate'], next: Date.now() + 900000}});
  await env.flushPower();
  assert.equal(env.powerCalls.at(-1), 'system');
  for (const status of ['Tamamlandı', 'Kullanıcı durdurdu', 'İşlem engellendi']) {
    await env.storage.local.set({[key]: {running: false, queue: ['candidate'], status}});
    await env.flushPower();
    assert.equal(env.powerCalls.at(-1), 'release');
    await env.storage.local.set({[key]: {running: true, queue: ['candidate'], next: Date.now() + 900000}});
    await env.flushPower();
    assert.equal(env.powerCalls.at(-1), 'system');
  }
  await env.storage.local.remove(key);
  await env.flushPower();
  assert.equal(env.powerCalls.at(-1), 'release');
  const idle = environment();
  await idle.flushPower();
  assert.deepEqual(idle.powerCalls, ['release']);
});

test('actual queue start and failure stop acquire and release the power request', async () => {
  const env = environment();
  const {send} = await startFollowFixture(env);
  await env.flushPower();
  assert.equal(env.powerCalls.at(-1), 'system');
  await send({type: 'follow-result', outcome: 'unverified', code: 'action_blocked'});
  await env.flushPower();
  assert.equal(env.powerCalls.at(-1), 'release');
});

test('MV3 package uses Instagram host, storage, alarms and account cookie access, with no userscript APIs or remote code', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(read('content.js').includes('data-studio-version'));
  assert.ok(read('content.js').includes('v' + manifest.version + '</small>'));
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'cookies', 'power']);
  assert.deepEqual(manifest.host_permissions, ['https://www.instagram.com/*']);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.doesNotMatch(read('content.js'), /GM_|eval\(|new Function|https:\/\/raw\.githubusercontent/);
});

test('panel uses Instagram page language for all tools, archive details and queue guidance', async t => {
  const date = new Date('2023-11-14T12:00:00Z');
  const archive = {[cacheKey]: {items: [{name: 'fixture_candidate', timestamp: date.getTime() / 1000}],
    filename: 'archive.zip', followingNames: ['fixture_candidate'], followerNames: [], followers: 0, following: 1}};
  for (const [language, labels] of [
    ['en-GB', ['Follow queue', 'Unfollow', 'Relationships', 'Messages']],
    ['tr-TR', ['Toplu takip', 'Takipten çık', 'Takipleşme', 'Mesajlar']],
    ['de', ['Follow queue', 'Unfollow', 'Relationships', 'Messages']]
  ]) {
    const {dom, panel} = await app(environment(archive), undefined, 1, language);
    t.after(() => dom.window.close());
    assert.deepEqual([...panel.querySelectorAll('.studio-tabs button')].map(tab => tab.textContent), labels);
    panel.querySelector('[data-open]').click();
    panel.querySelector('#studio-tab-unfollow').click();
    await new Promise(resolve => setImmediate(resolve));
    if (language === 'en-GB') {
      assert.match(panel.querySelector('[data-caption]').textContent, /Saved list · archive.zip · As of the archive date/);
      assert.equal(panel.querySelector('.date').textContent, 'Recorded follow date · ' + date.toLocaleDateString('en-GB'));
      assert.match(panel.querySelector('#studio-view-unfollow').textContent, /Start processes the ZIP candidates in the current list/);
      panel.querySelector('#studio-tab-relationships').click();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(panel.querySelector('[data-relationship-archive] summary').textContent, 'Import an Instagram JSON archive');
    }
  }
});

test('photos already loaded by Instagram render inline, recorded re-follows take priority, and protected accounts can be released', async t => {
  const timestamp = Date.parse('2026-06-15T12:00:00Z');
  const photo = 'https://scontent.cdninstagram.com/avatar-fixture.jpg';
  const account = {id: '1001', storeId: '0'};
  const protectedKey = 'follow-studio-protected';
  const item = {name: 'fixture_candidate', timestamp: 1700000000};
  const env = environment({[cacheKey]: {items: [], followingNames: [item.name], followerNames: [], followers: 0, following: 1},
    [protectedKey]: {[item.name]: item}, 'follow-studio-follow-queue': {account, queue: [], history: [
      {name: item.name, time: timestamp, outcome: 'followed'},
      {name: item.name, time: timestamp + 100000, outcome: 'already'}
    ]}});
  const details = await env.send({type: 'studio-profile-details', photos: {[item.name]: photo}});
  assert.equal(details.photos[item.name], photo);
  const {dom, w, panel} = await app(env, undefined, 1, 'en-GB');
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  panel.querySelector('#studio-tab-unfollow').click();
  panel.querySelector('[data-tab="protected"]').click();
  await new Promise(resolve => setImmediate(resolve));
  const row = panel.querySelector('[data-results] .account');
  const avatar = row.querySelector('.avatar');
  assert.match(avatar.textContent, /^FI/);
  const image = avatar.querySelector('img');
  assert.equal(image.src, photo);
  image.dispatchEvent(new w.Event('load'));
  assert.equal(image.style.opacity, '1');
  assert.match(row.querySelector('.date').textContent, /15\/06\/2026/);
  row.querySelector('button[aria-label="Remove protection for fixture_candidate"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.local[protectedKey][item.name], undefined);
  assert.deepEqual(env.local[cacheKey].items.map(entry => entry.name), [item.name]);
  assert.equal(env.local[jobKey], undefined);
  env.setAccount('1002');
  const other = await env.send({type: 'studio-profile-details'});
  assert.equal(Object.keys(other.photos).length + Object.keys(other.followedAt).length, 0);
});

test('already loaded Instagram avatars are captured without requesting pages or starting an unfollow', async t => {
  const names = ['fixture_candidate', 'fixture_other'];
  const photo = 'https://scontent.cdninstagram.com/avatar-fixture.jpg';
  const env = environment({[cacheKey]: {items: names.map(name => ({name})),
    followingNames: names, followerNames: [], followers: 0, following: 2}});
  const {dom, panel, w} = await app(env, undefined, 1, 'en');
  t.after(() => dom.window.close());
  w.fetch = () => assert.fail('Photo collection must not fetch Instagram pages');

  for (const [name, url] of [[names[0], photo], [names[1], 'https://example.invalid/other.jpg'],
    ['unrelated', 'https://scontent.cdninstagram.com/unrelated.jpg']]) {
    const link = w.document.createElement('a');
    link.href = '/' + name + '/';
    const image = w.document.createElement('img');
    image.src = url;
    Object.defineProperties(image, {
      complete: {value: true}, naturalWidth: {value: 150}, naturalHeight: {value: 150}
    });
    image.getClientRects = () => [{}];
    link.append(image);
    w.document.body.append(link);
    image.dispatchEvent(new w.Event('load'));
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  panel.querySelector('[data-open]').click();
  panel.querySelector('#studio-tab-unfollow').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...panel.querySelectorAll('[data-results] .avatar img')].map(image => image.src), [photo]);
  assert.deepEqual(env.local['follow-studio-observed-photos'].photos, {[names[0]]: photo});
  assert.equal(env.tabs.size, 2);
  assert.equal(env.local[relationshipsKey], undefined);
  assert.equal(env.session['follow-studio-session'].owner, null);
  assert.equal(env.local[jobKey], undefined);
});

test('unfollow ZIP keeps the newest known follow date if a username appears twice', async t => {
  const env = environment();
  const {dom, panel, w} = await app(env);
  t.after(() => dom.window.close());
  const input = panel.querySelector('[data-zip]');
  const file = new w.File([zipJson({
    'followers_1.json': [],
    'following.json': {relationships_following: [20, 10].map(timestamp => ({
      title: 'fixture_candidate', string_list_data: [{timestamp}]
    }))}
  })], 'duplicate-fixture.zip');
  await input.onchange({target: {files: [file]}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.local[cacheKey].following, 1);
  assert.equal(env.local[cacheKey].items[0].timestamp, 20);
});

test('native extension UI works without Monkey and removes successful accounts', async t => {
  const env = environment({[cacheKey]: {items: [{name: 'fixture_candidate', timestamp: 1}],
    followingNames: ['fixture_candidate', 'fixture_mutual'], followerNames: ['fixture_mutual'], followers: 1, following: 2},
    [relationshipsKey]: unfollowRelationshipFixture()});
  const {dom, panel} = await app(env);
  t.after(() => dom.window.close());
  assert.equal(panel.querySelector('[data-veil]').hidden, true);
  assert.equal(panel.querySelector('#wait-seconds').value, '5');
  panel.querySelector('[data-mode]').value = 'background'; panel.querySelector('#wait-seconds').value = '0';
  const seen = [];
  env.onCreated(tab => {
    const job = env.local[jobKey]; seen.push(job.username);
    env.storage.local.set({[jobKey]: {...job, state: 'done', outcome: 'unfollowed', message: 'Synthetic success'}});
  });
  panel.querySelector('[data-manual] textarea').value = 'fixture_mutual fixture_candidate';
  await panel.querySelector('[data-start]').onclick();
  assert.deepEqual(seen, ['fixture_candidate']);
  assert.equal(env.local[cacheKey].items.length, 0);
  assert.equal(env.local['follow-studio-run-summary'].unfollowed, 1);
  assert.equal(env.session['follow-studio-session'].owner, null);
  assert.equal(env.tabs.size, 2, 'Worker tab closed');
});

const dmQueueKey = 'follow-studio-dm-queue';
const dmFixtureThread = 'https://www.instagram.com/direct/t/123456789/';

test('the Messages tab defaults to unsending and removing reactions after the user presses Start', async t => {
  const env = environment();
  const {dom, panel} = await app(env, 'https://www.instagram.com/', 1, 'en');
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  panel.querySelector('#studio-tab-messages').click();
  await new Promise(resolve => setImmediate(resolve));
  const start = panel.querySelector('[data-dm-start]');
  const username = panel.querySelector('[data-dm-username]');
  const reactions = panel.querySelector('[data-dm-reactions]');
  assert.equal(reactions.checked, true);
  assert.equal(panel.querySelector('[data-dm-confirm]'), null);
  assert.equal(start.disabled, true);
  assert.equal((await env.send({type: 'dm-start', confirmed: true})).ok, false, 'No username was provided');
  assert.equal((await env.send({type: 'dm-start'}, 1, 0, dmFixtureThread)).ok, false);
  assert.equal(env.local[dmQueueKey], undefined);
  username.value = '@Fixture_Target';
  username.dispatchEvent(new dom.window.Event('input'));
  assert.equal(start.disabled, false);
  assert.equal(start.textContent, 'Unsend messages and remove reactions');
  await start.onclick();
  const job = env.local[dmQueueKey];
  const worker = env.tabs.get(job.tabId);
  assert.equal(worker.active, true);
  assert.equal(worker.autoDiscardable, false);
  assert.equal(env.windows[0].type, 'popup');
  assert.equal(env.windows[0].focused, false);
  assert.equal(worker.windowId, env.windows[0].id);
  assert.equal((await env.send({type: 'dm-show'}, 2)).ok, true);
  assert.equal(env.windows[0].focused, true);
  assert.equal(job.username, 'fixture_target');
  assert.equal(job.options.messages, true);
  assert.equal(job.options.reactions, true);
  assert.match(env.tabs.get(job.tabId).url, /\/fixture_target\//);
  assert.equal(job.thread, null);
  assert.equal(job.running, true);
  assert.match(panel.querySelector('[data-dm-status]').textContent, /Message job running in the background/);

  env.tabs.delete(1);
  for (const listener of env.removed) listener(1, {isWindowClosing: false});
  await env.send({type: 'studio-ready'}, 2);
  assert.equal(env.local[dmQueueKey].running, true);
  assert.equal(env.local[dmQueueKey].tabId, job.tabId);
  assert.equal((await env.send({type: 'dm-stop'}, 2)).ok, true);
  assert.equal(env.tabs.has(job.tabId), false);
  assert.equal(env.local[dmQueueKey].running, false);
});

test('a closed worker is replaced before an unsend but an interrupted confirmation is not replayed', async () => {
  const env = environment();
  await env.send({type: 'dm-start', confirmed: true, username: 'fixture_target'});
  const first = env.local[dmQueueKey];
  async function close(tabId) {
    env.tabs.delete(tabId);
    for (const listener of env.removed) listener(tabId, {isWindowClosing: false});
    await env.send({type: 'studio-ready'}, 2);
  }
  await close(first.tabId);
  const worker = env.local[dmQueueKey];
  assert.notEqual(worker.tabId, first.tabId);
  assert.equal(worker.id, first.id);
  const url = dmFixtureThread;
  env.tabs.get(worker.tabId).url = url;
  assert.equal((await env.send({type: 'dm-commit', id: worker.id}, worker.tabId, 0, url)).ok, false);
  assert.equal((await env.send({type: 'dm-resume'}, worker.tabId, 0, url)).id, worker.id);
  assert.equal((await env.send({type: 'dm-bind', id: worker.id, username: 'wrong'}, worker.tabId, 0, url)).ok, false);
  assert.equal((await env.send({type: 'dm-bind', id: worker.id, username: 'fixture_target'}, worker.tabId, 0, url)).ok, true);
  assert.equal((await env.send({type: 'dm-resume'}, worker.tabId, 0, 'https://www.instagram.com/direct/t/999/')).ok, false);
  assert.equal((await env.send({type: 'dm-commit', id: worker.id}, worker.tabId, 0, url)).ok, true);
  await close(worker.tabId);
  assert.equal(env.local[dmQueueKey].running, false);
  assert.equal(env.local[dmQueueKey].count, 0);
  assert.match(env.local[dmQueueKey].status, /sonucu belirsiz/);
  assert.equal(env.tabs.size, 2);
});

async function runDmWorker(env, t, variant) {
  const reactions = variant === 'reaction' || variant === 'reaction-preview';
  await env.send({type: 'dm-start', confirmed: !reactions, removeReactions: reactions,
    preview: variant === 'preview-menu' || variant === 'reaction-preview', username: 'fixture_target'});
  const job = env.local[dmQueueKey];
  const url = dmFixtureThread;
  const profileUrl = env.tabs.get(job.tabId).url;
  env.tabs.get(job.tabId).url = url;
  const chat = `<main><div><a aria-label="Open the profile page of target" href="/${variant === 'wrong' ? 'another_person' : 'fixture_target'}/">Profile</a></div><div data-pagelet="IGDMessagesList">
    <div role="row" id="incoming"><button aria-label="More options">⋯</button></div>
    <div role="row" id="outgoing" style="display:flex;justify-content:flex-end">
      <button aria-label="See more options for message">⋯</button>
    </div></div></main>`;
  const dom = new JSDOM(`<html lang="en"><body>${chat}</body></html>`,
    {url, runScripts: 'outside-only', pretendToBeVisual: variant !== 'hidden'});
  t.after(() => dom.window.close());
  const w = dom.window;
  const outgoing = w.document.getElementById('outgoing');
  let elapsed = 0;
  w.Date.now = () => elapsed;
  w.setTimeout = (fn, ms) => { elapsed += ms; return setImmediate(fn); };
  w.HTMLElement.prototype.getClientRects = () => [{}];
  w.HTMLElement.prototype.getBoundingClientRect = () => ({top: 0, bottom: 100, height: 100, width: 100, x: 0, y: 0});
  let cancelClicks = 0;
  let incomingClicks = 0;
  let confirmations = 0;
  let reactionRemovals = 0;
  w.document.querySelector('#incoming button').onclick = () => incomingClicks++;
  const more = outgoing.querySelector('button');
  let upwardMoves = 0;
  if (variant === 'reverse-scroll') {
    const list = w.document.querySelector('[data-pagelet="IGDMessagesList"]');
    const oldest = outgoing.cloneNode(true);
    const scroller = w.document.createElement('div');
    scroller.style.cssText = 'overflow-y:scroll;display:flex;flex-direction:column-reverse';
    scroller.append(...list.children);
    list.append(scroller);
    let top = 0;
    Object.defineProperties(scroller, {
      clientHeight: {get: () => 100},
      scrollHeight: {get: () => confirmations ? 400 : 100},
      scrollTop: {get: () => top, set: value => {
        if (value < top) upwardMoves++;
        top = value;
        if (upwardMoves === 1 && !oldest.isConnected && confirmations === 1) {
          oldest.querySelector('button').onclick = () => openMessageActions(oldest);
          scroller.append(oldest);
        }
      }}
    });
  }
  function openMessageActions(row) {
    const instagramPopover = variant === 'instagram-popover';
    const menu = w.document.createElement('div');
    menu.setAttribute('role', instagramPopover ? 'dialog' : 'menu');
    menu.innerHTML = instagramPopover ?
      '<div role="button"><span>Copy</span></div><div role="button"><div><span>Unsend</span><span>Additional text</span></div></div>' :
      '<div role="menuitem"><span>Unsend</span></div>';
    menu.lastElementChild.onclick = () => {
      assert.equal(env.local[dmQueueKey].pending, true);
      const dialog = instagramPopover ? menu : w.document.createElement('div');
      if (!instagramPopover) menu.remove();
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<button>Cancel</button><button>Unsend</button>';
      const [cancel, unsend] = dialog.querySelectorAll('button');
      cancel.onclick = () => cancelClicks++;
      unsend.onclick = () => {
        confirmations++;
        dialog.remove();
        row.remove();
        if (variant === 'rerender' && confirmations === 1) {
          const list = w.document.querySelector('[data-pagelet="IGDMessagesList"]');
          const replacement = list.cloneNode(true);
          const older = outgoing.cloneNode(true);
          older.querySelector('button').onclick = () => openMessageActions(older);
          replacement.append(older);
          list.replaceWith(replacement);
        }
      };
      w.document.body.append(dialog);
    };
    w.document.body.append(menu);
  }
  if (variant === 'instagram-popover') {
    more.onkeydown = event => { if (event.key === 'Enter') openMessageActions(outgoing); };
  } else {
    more.onclick = () => openMessageActions(outgoing);
  }
  if (variant === 'restricted') {
    w.document.body.insertAdjacentHTML('beforeend', '<div role="alert">Try again later</div>');
  }
  if (reactions) {
    const incoming = w.document.getElementById('incoming');
    incoming.innerHTML = '<div aria-roledescription="message">Synthetic incoming</div>' +
      '<svg aria-label="See more options for message from fixture_target"></svg><div role="button">❤️😂</div>';
    const badge = incoming.querySelector('[role="button"]');
    badge.onclick = () => {
      const dialog = w.document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = '<h2>Reactions</h2><button>Close</button><button>Other person 😂</button>' +
        (reactionRemovals ? '' : '<div role="button"><span>Me</span><span>Select to remove</span><span>❤️</span></div>');
      const [close, other, own] = dialog.querySelectorAll('button,[role="button"]');
      close.onclick = () => dialog.remove();
      other.onclick = () => assert.fail('Someone else’s reaction was selected');
      if (own) own.onclick = () => {
        assert.equal(env.local[dmQueueKey].operation, 'reaction');
        reactionRemovals++;
        badge.textContent = '😂';
        dialog.remove();
      };
      w.document.body.append(dialog);
    };
  }
  if (variant === 'skip-menu') {
    const blocked = outgoing.cloneNode(true);
    blocked.removeAttribute('id');
    blocked.querySelector('button').onclick = () => {
      const menu = w.document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<button>Copy</button>';
      w.document.body.append(menu);
      w.document.addEventListener('keydown', event => {
        if (event.key === 'Escape') menu.remove();
      }, {once: true});
    };
    outgoing.after(blocked);
  }
  if (variant === 'rerender') {
    const chatPage = w.document.querySelector('main');
    env.tabs.get(job.tabId).url = profileUrl;
    w.history.replaceState(null, '', profileUrl);
    w.document.body.innerHTML = '<main><header><h2>fixture_target</h2><button>Message</button></header></main>';
    w.document.querySelector('button').onclick = () => {
      const popup = w.document.createElement('div');
      popup.innerHTML = '<div><div role="button"><svg aria-label="Expand"></svg></div><div role="button"><svg aria-label="Close"></svg></div></div><div contenteditable="true"></div>';
      popup.querySelector('[role="button"]').onclick = () => {
        assert.equal(env.local[dmQueueKey].pending, false);
        w.history.pushState(null, '', url);
        env.tabs.get(job.tabId).url = url;
        w.document.body.replaceChildren(chatPage);
      };
      w.document.body.append(popup);
    };
  }
  w.chrome = {runtime: {sendMessage: message => {
    if (message.type === 'dm-delay') elapsed += message.ms;
    return env.send(message, job.tabId, 0, variant === 'rerender' ? profileUrl : w.location.href);
  }}};
  w.eval(read('i18n.js'));
  w.eval(read('dm-content.js'));
  await w.eval(read('content.js'));
  if (reactions) return {confirmations, reactionRemovals};
  return variant === 'reverse-scroll' ? {confirmations, upwardMoves} : {cancelClicks, incomingClicks, confirmations};
}

test('the worker confirms only the Instagram Unsend button, leaves incoming messages alone, and stops on restrictions', async t => {
  const env = environment();
  assert.deepEqual(await runDmWorker(env, t), {cancelClicks: 0, incomingClicks: 0, confirmations: 1});
  assert.equal(env.local[dmQueueKey].count, 1);
  assert.equal(env.local[dmQueueKey].running, false);
  const restricted = environment();
  assert.deepEqual(await runDmWorker(restricted, t, 'restricted'), {cancelClicks: 0, incomingClicks: 0, confirmations: 0});
  assert.equal(restricted.local[dmQueueKey].count, 0);
  assert.match(restricted.local[dmQueueKey].status, /kısıtlama/);
});

test('checking a chat finds the live-style Unsend menu without activating it', async t => {
  const env = environment();
  assert.equal((await runDmWorker(env, t, 'preview-menu')).confirmations, 0);
  assert.equal(env.local[dmQueueKey].count, 0);
  assert.equal(env.local[dmQueueKey].pending, false);
  assert.match(env.local[dmQueueKey].status, /Geri Al menüsü doğrulandı/);
});

test('the reaction option removes only the signed-in user’s reaction and verifies the remaining reaction', async t => {
  const env = environment();
  assert.deepEqual(await runDmWorker(env, t, 'reaction'), {confirmations: 0, reactionRemovals: 1});
  assert.equal(env.local[dmQueueKey].count, 0);
  assert.equal(env.local[dmQueueKey].reactions, 1);
  const preview = environment();
  assert.deepEqual(await runDmWorker(preview, t, 'reaction-preview'), {confirmations: 0, reactionRemovals: 0});
  assert.match(preview.local[dmQueueKey].status, /kaldırma seçeneği doğrulandı/);
});

test('the worker finds Instagram’s dialog popover, nested Unsend label and separate confirmation after keyboard activation', async t => {
  const env = environment();
  assert.deepEqual(await runDmWorker(env, t, 'instagram-popover'),
    {cancelClicks: 0, incomingClicks: 0, confirmations: 1});
  assert.equal(env.local[dmQueueKey].count, 1);
  assert.equal(env.local[dmQueueKey].running, false);
});

test('the message worker opens the full thread from a profile chat popup, verifies the recipient and keeps going after rerender', async t => {
  const wrong = environment();
  assert.equal((await runDmWorker(wrong, t, 'wrong')).confirmations, 0);
  assert.match(wrong.local[dmQueueKey].status, /doğrulanamadı/);
  const env = environment();
  assert.equal((await runDmWorker(env, t, 'rerender')).confirmations, 2);
  assert.equal(env.local[dmQueueKey].count, 2);
  assert.equal(env.local[dmQueueKey].status, 'Mesaj işlemi tamamlandı.');
});

test('the worker scrolls a reversed message viewport that starts without overflow and handles older loaded messages', async t => {
  const env = environment();
  const result = await runDmWorker(env, t, 'reverse-scroll');
  assert.ok(result.upwardMoves >= 2);
  assert.equal(result.confirmations, 2);
  assert.equal(env.local[dmQueueKey].count, 2);
  assert.equal(env.local[dmQueueKey].status, 'Mesaj işlemi tamamlandı.');
});

test('checking a chat can bind the current tab but cannot commit an unsend', async () => {
  const env = environment();
  assert.equal((await env.send({type: 'dm-start', preview: true, username: 'fixture_target'})).ok, true);
  const job = env.local[dmQueueKey];
  const profileUrl = env.tabs.get(job.tabId).url;
  env.tabs.get(job.tabId).url = dmFixtureThread;
  const send = (type, data = {}) => env.send({type, id: job.id, ...data}, job.tabId, 0, profileUrl);
  assert.equal((await send('dm-bind', {username: 'fixture_target'})).preview, true);
  assert.equal((await send('dm-check')).ok, true);
  assert.equal((await send('dm-commit')).ok, false);
  assert.equal((await send('dm-finish', {scrolled: true})).ok, true);
  assert.equal(env.local[dmQueueKey].count, 0);
});

test('a missing Unsend option skips that row, continues and leaves the worker open for review', async t => {
  const env = environment();
  assert.equal((await runDmWorker(env, t, 'skip-menu')).confirmations, 1);
  assert.equal(env.local[dmQueueKey].count, 1);
  assert.match(env.local[dmQueueKey].status, /1 mesaj geri alınamadı/);
  assert.equal(env.tabs.size, 3);
});

test('a hidden worker uses background waits and still verifies a message removal', async t => {
  const env = environment();
  assert.equal((await runDmWorker(env, t, 'hidden')).confirmations, 1);
  assert.ok(env.backgroundDelays.includes(650), 'The removal verification wait ran in the extension service worker');
  assert.ok(env.backgroundDelays.includes(1400), 'The scroll wait ran in the extension service worker');
  assert.equal(env.local[dmQueueKey].count, 1);
});

test('the work window stays beside Brave without taking focus and restores the previous layout on stop', async () => {
  const original = {id: 70, type: 'normal', state: 'maximized', left: 0, top: 0, width: 1600, height: 900};
  const env = environment({}, original);
  assert.equal((await env.send({type: 'dm-start', preview: true, username: 'fixture_target'})).ok, true);
  const [main, worker] = env.windows;
  assert.equal(main.state, 'normal');
  assert.equal(main.left + main.width, worker.left);
  assert.equal(worker.left + worker.width, original.width);
  assert.equal(worker.focused, false);
  assert.equal((await env.send({type: 'dm-stop'}, 1)).ok, true);
  assert.equal(main.state, 'maximized');
});

test('background owns worker tabs, rejects concurrent controllers, rechecks follower/protection before clicks', async () => {
  const env = environment({[cacheKey]: {followingNames: ['fixture_candidate'], followerNames: []},
    [relationshipsKey]: unfollowRelationshipFixture(),
    [jobKey]: {id: 'fixture-job', username: 'fixture_candidate', state: 'running'}});
  assert.equal((await env.send({type: 'studio-claim'})).claimed, true);
  assert.equal((await env.send({type: 'studio-claim'}, 2)).claimed, false);
  assert.equal((await env.send({type: 'studio-open-worker', url: 'https://example.com/'})).ok, false);
  const opened = await env.send({type: 'studio-open-worker', url: 'https://www.instagram.com/fixture_candidate/?local_unfollow_job=fixture-job'});
  assert.equal(opened.ok, true);
  env.updated.forEach(fn => fn(opened.tabId, {status: 'loading'}));
  const check = () => env.send({type: 'studio-check', id: 'fixture-job', username: 'fixture_candidate'}, opened.tabId, 0, 'https://www.instagram.com/fixture_candidate/?local_unfollow_job=fixture-job');
  assert.equal((await check()).ok, true, 'Worker navigation must not clear its authorization');
  await env.storage.local.set({'follow-studio-protected': {fixture_candidate: {name: 'fixture_candidate'}}});
  assert.equal((await check()).outcome, 'protected');
  await env.storage.local.set({'follow-studio-protected': {}, [cacheKey]: {followingNames: ['fixture_candidate'], followerNames: ['fixture_candidate']}});
  assert.equal((await check()).outcome, 'follower');
  await env.storage.local.set({[cacheKey]: {followingNames: ['fixture_candidate'], followerNames: []}});
  env.setAccount('1002');
  assert.equal((await check()).ok, false, 'A different Instagram account cannot reuse authorization');
  env.setAccount('1001');
  await env.storage.local.set({[relationshipsKey]: unfollowRelationshipFixture({at: Date.now() - 11 * 60000})});
  assert.equal((await check()).ok, false, 'An expired scan cannot authorize the next click');
  await env.storage.local.set({[relationshipsKey]: unfollowRelationshipFixture()});
  assert.equal((await env.send({type: 'studio-close-worker', tabId: 2})).ok, false);
  await env.send({type: 'studio-release'});
  assert.equal(env.tabs.has(opened.tabId), false);
  assert.equal((await env.send({type: 'studio-claim'}, 2)).claimed, true);
  env.updated.forEach(fn => fn(2, {status: 'loading'}));
  assert.equal((await env.send({type: 'studio-claim'})).claimed, true, 'Reload releases owner');
});

test('unfollow skips accounts that follow back or are missing from a complete live scan before opening a worker', async t => {
  const names = ['fixture_follower', 'fixture_missing'];
  const env = environment({[cacheKey]: {items: names.map(name => ({name, timestamp: 1})),
    followingNames: names, followerNames: [], followers: 0, following: 2},
    [relationshipsKey]: unfollowRelationshipFixture({followers: [names[0]], following: [names[0]]})});
  const {dom, panel, w} = await app(env);
  t.after(() => dom.window.close());
  let workerTabs = 0;
  env.onCreated(() => workerTabs++);
  panel.querySelector('[data-manual] textarea').value = names.join(' ');
  for (const mode of ['background', 'iframe']) {
    panel.querySelector('[data-mode]').value = mode;
    await panel.querySelector('[data-start]').onclick();
    assert.equal(env.local[jobKey], undefined);
    assert.equal(workerTabs, 0);
    assert.equal(w.document.querySelector('iframe'), null);
    assert.equal(env.local[cacheKey].items.length, 2);
    assert.match(panel.querySelector('.activity pre').textContent, /fixture_follower: Canlı listede seni takip ediyor/);
    assert.match(panel.querySelector('.activity pre').textContent, /fixture_missing: Canlı takip edilenler listesinde doğrulanamadı/);
  }
});

test('Start processes the entire current ZIP list with no per-account selection', async t => {
  const names = ['fixture_first', 'fixture_second', 'fixture_protected', 'fixture_follower', 'fixture_excluded'];
  const env = environment({[cacheKey]: {items: names.map((name, i) => ({name, timestamp: i + 1})),
    importedAt: 123, followingNames: names, followerNames: ['fixture_follower'], following: names.length,
    followers: 1, excluded: ['fixture_excluded']},
    'follow-studio-protected': {fixture_protected: {name: 'fixture_protected'}}});
  const {dom, panel} = await app(env, undefined, 1, 'en');
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  panel.querySelector('#studio-tab-unfollow').click();
  assert.equal(panel.querySelector('[data-results] input[type=checkbox]'), null);
  assert.deepEqual([...panel.querySelectorAll('[data-results] .account-info a')].map(link => link.textContent),
    ['@fixture_first', '@fixture_second']);
  panel.querySelector('[data-manual] textarea').value = 'fixture_first';
  panel.querySelector('[data-mode]').value = 'background';
  panel.querySelector('#wait-seconds').value = '0';
  const attempted = [];
  env.onCreated(() => {
    const job = env.local[jobKey];
    attempted.push(job.username);
    void env.storage.local.set({[jobKey]: {...job, state: 'done', outcome: 'unfollowed', message: 'Synthetic result'}});
  });
  await panel.querySelector('[data-start]').onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(attempted, names.slice(0, 2));
  assert.equal(env.tabs.size, 2);
  assert.equal(env.local['follow-studio-run-summary'].unfollowed, 2);
  assert.equal(env.local[relationshipsKey], undefined, 'Starting from the ZIP must not scan follower lists');
});

test('ZIP-based runs require valid archive data and stop on archive or Instagram account changes', async () => {
  const name = 'fixture_target';
  const archive = {items: [{name}], importedAt: 123, filename: 'fixture.zip', followingNames: [name], followerNames: []};
  const env = environment({[cacheKey]: {items: [{name}]}});
  const claim = () => env.send({type: 'studio-claim'});
  const check = () => env.send({type: 'studio-verify-candidate', username: name});
  assert.equal((await claim()).ok, false);
  await env.storage.local.set({[cacheKey]: archive});
  assert.equal((await claim()).claimed, true);
  assert.equal((await check()).ok, true);
  await env.storage.local.set({[cacheKey]: {...archive, importedAt: 124}});
  assert.match((await check()).error, /ZIP arşivi işlem sırasında değişti/);
  await env.storage.local.set({[cacheKey]: archive});
  env.setAccount('2002');
  assert.match((await check()).error, /Instagram hesabı işlem sırasında değişti/);
  assert.equal(env.tabs.size, 2);
});

test('storage persistence failure prevents a worker from opening', async t => {
  const env = environment({[cacheKey]: {items: [{name: 'fixture_candidate', timestamp: 1}],
    followingNames: ['fixture_candidate'], followerNames: []},
    [relationshipsKey]: unfollowRelationshipFixture()});
  const {dom, w} = await app(env);
  t.after(() => dom.window.close());
  const bridge = await w.FollowStudioBridge.connect();
  assert.equal(await bridge.claim(), true);
  env.storage.local.set = async () => { throw new Error('Synthetic storage failure'); };
  bridge.setValue('fixture_key', 'fixture_value');
  await assert.rejects(bridge.openTab('https://www.instagram.com/fixture_candidate/'), /kaydedilemedi/);
  assert.equal(env.tabs.size, 2);
  await assert.rejects(bridge.release(), /kaydedilemedi/);
  assert.equal(env.session['follow-studio-session'].owner, null, 'Storage failure must not leave the controller locked');
});

test('follow queue opens inactive tabs, logs confirmed follows and pauses with a separate failed list', async t => {
  const env = environment();
  const key = 'follow-studio-follow-queue';
  const profile = name => 'https://www.instagram.com/' + name + '/';
  for (const name of ['first', 'second', 'third', 'first']) {
    assert.equal((await env.send({type: 'follow-add'}, 1, 0, profile(name))).ok, true);
  }
  assert.deepEqual(env.local[key].queue, ['first', 'second', 'third']);
  assert.equal((await env.send({type: 'follow-start', settings: {min: 1, max: 1, batch: 1, rest: 15}})).ok, true);
  assert.equal((await env.send({type: 'studio-claim'})).ok, false);
  const wake = async () => {
    env.local[key].next = 1;
    env.alarms[0]({name: 'follow-studio-next-follow'});
    await env.send({type: 'studio-ready'});
    const {job} = env.local[key];
    const tab = env.tabs.get(job.tabId);
    assert.equal(tab.active, false);
    return {job, tab};
  };
  const {job, tab} = await wake();
  assert.equal((await env.send({type: 'follow-check', id: job.id}, 1, 0, tab.url)).ok, false);

  const dom = new JSDOM('<main><header><h2>first</h2><button>Takip Et</button></header></main>',
    {url: tab.url, runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const {window: w} = dom;
  const button = w.document.querySelector('button');
  w.document.querySelector('h2').getClientRects = () => [{}];
  button.getClientRects = () => [{}];
  let clicks = 0;
  button.onclick = () => { clicks++; w.setTimeout(() => { button.textContent = 'Takiptesin'; }, 20); };
  w.chrome = {runtime: {sendMessage: message => env.send(message, tab.id, 0, tab.url)}};
  w.eval(read('i18n.js'));
  w.eval(read('follow-content.js'));
  await w.eval('FollowStudioQueue.work(' + JSON.stringify(job.id) + ')');
  assert.equal(env.local[key].job.phase, 'verifying');
  assert.equal(env.local[key].history.length, 0);
  await w.eval('FollowStudioQueue.work(' + JSON.stringify(job.id) + ')');
  assert.equal(clicks, 1);
  assert.deepEqual(env.local[key].queue, ['second', 'third']);
  assert.equal(env.local[key].history[0].outcome, 'followed');
  assert.equal(env.tabs.has(tab.id), false);
  assert.ok(env.local[key].next - Date.now() > 15 * 60_000);

  const second = await wake();
  await env.send({type: 'follow-result', id: second.job.id, outcome: 'unverified'},
    second.tab.id, 0, second.tab.url);
  assert.equal(env.local[key].running, false);
  assert.deepEqual(env.local[key].queue, ['third']);
  assert.deepEqual(env.local[key].failed.map(entry => entry.name), ['second']);
  assert.equal(env.local[key].history.length, 1);
  assert.equal(env.tabs.has(second.tab.id), false);
  env.alarms[0]({name: 'follow-studio-next-follow'});
  await env.send({type: 'studio-ready'});
  assert.equal(env.tabs.size, 2);
  assert.equal((await env.send({type: 'follow-add'}, 1, 0, profile('second'))).ok, false);

  const {settings} = env.local[key];
  await env.send({type: 'follow-start', settings});
  const third = await wake();
  assert.equal(third.job.name, 'third');
  await env.send({type: 'follow-add'}, 1, 0, profile('fourth'));
  await env.send({type: 'follow-verify', id: third.job.id, outcome: 'requested'}, third.tab.id, 0, third.tab.url);
  await env.send({type: 'follow-check', id: third.job.id}, third.tab.id, 0, third.tab.url);
  await env.send({type: 'follow-result', id: third.job.id, outcome: 'requested'}, third.tab.id, 0, third.tab.url);
  assert.equal(env.local[key].running, true);
  assert.deepEqual(env.local[key].queue, ['fourth']);
  assert.equal(env.local[key].history.length, 2);
  assert.equal(env.local[key].history[0].outcome, 'requested');
  assert.deepEqual(env.local[key].failed.map(entry => entry.name), ['second']);
  await env.send({type: 'follow-stop'});
  assert.equal((await env.send({type: 'follow-requeue', name: 'second'})).ok, true);
  assert.deepEqual(env.local[key].queue, ['fourth', 'second']);
  assert.deepEqual(env.local[key].failed, []);
  assert.equal(env.local[key].running, false);
});

test('profile icon adds without opening the floating panel, which renders rows only while open', async t => {
  const env = environment();
  const {dom, w, panel} = await app(env, 'https://www.instagram.com/fixture_profile/');
  t.after(() => dom.window.close());
  w.document.body.insertAdjacentHTML('afterbegin', '<main><header><h2>fixture_profile</h2></header></main>');
  w.document.querySelector('main h2').getClientRects = () => [{}];
  const quick = panel.querySelector('[data-follow-quick]');
  const gear = panel.querySelector('[data-open]');
  const floating = panel.querySelector('[data-veil]');
  assert.equal(quick.hidden, false);
  assert.equal(quick.getAttribute('aria-label'), 'Takip kuyruğuna ekle');
  await quick.onclick();
  assert.equal(floating.hidden, true);
  assert.deepEqual(env.local['follow-studio-follow-queue'].queue, ['fixture_profile']);
  assert.equal(quick.hasAttribute('data-queued'), true);
  assert.match(quick.getAttribute('aria-label'), /Kuyruktan kaldır/);
  const list = panel.querySelector('[data-follow-list]');
  assert.equal(list.children.length, 0);
  gear.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
  assert.equal(floating.querySelector('[aria-modal]'), null);
  assert.match(list.textContent, /@fixture_profile/);
  gear.click();
  assert.equal(floating.hidden, true);
  assert.equal(list.children.length, 0);
  await quick.onclick();
  assert.equal(floating.hidden, true);
  assert.equal(quick.hasAttribute('data-queued'), false);
  assert.equal(quick.getAttribute('aria-label'), 'Takip kuyruğuna ekle');
  assert.deepEqual(env.local['follow-studio-follow-queue'].queue, []);
});

test('bulk follow entry accepts 100 lines, skips duplicates and keeps held profiles separate', async t => {
  const key = 'follow-studio-follow-queue';
  const env = environment({[key]: {queue: ['existing'], history: [], running: false,
    failed: [{name: 'held_profile', reason: 'Takip doğrulanamadı.', time: 1}]}});
  const {dom, panel} = await app(env);
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  const form = panel.querySelector('[data-follow-add-list]');
  const input = form.querySelector('textarea');
  const names = Array.from({length: 100}, (_, i) => 'profile_' + i);
  input.value = [' @Existing ', ...names.map((name, i) => i % 2 ? name : '@' + name),
    '@PROFILE_0', '', '@held_profile', 'two names', 'accounts'].join('\r\n');
  await form.onsubmit({preventDefault() {}});
  assert.deepEqual(env.local[key].queue, ['existing', ...names]);
  assert.deepEqual(env.local[key].failed.map(entry => entry.name), ['held_profile']);
  assert.equal(env.local[key].running, false);
  assert.equal(form.querySelector('[role="status"]').textContent,
    '100 eklendi · 2 tekrar atlandı · 1 doğrulanamayan profillerde · 2 geçersiz satır');
  const add = await env.send({type: 'follow-add'}, 1, 0, 'https://www.instagram.com/PROFILE_0/');
  assert.match(add.status, /zaten kuyrukta/);
  assert.equal(env.local[key].queue.length, 101);
});

test('studio tabs switch independently and render only the active tool', async t => {
  const env = environment({'follow-studio-follow-queue': {queue: ['follow_target']},
    [cacheKey]: {items: [{name: 'unfollow_target', timestamp: 1}], followingNames: ['unfollow_target'],
      followerNames: [], followers: 0, following: 1}});
  const {dom, w, panel} = await app(env);
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  await new Promise(resolve => setImmediate(resolve));
  const follow = panel.querySelector('#studio-tab-follow');
  const unfollow = panel.querySelector('#studio-tab-unfollow');
  const queue = panel.querySelector('[data-follow-list]');
  const results = panel.querySelector('[data-results]');
  assert.equal(follow.getAttribute('aria-selected'), 'true');
  assert.match(queue.textContent, /follow_target/);
  assert.equal(results.children.length, 0);
  follow.dispatchEvent(new w.KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
  assert.equal(unfollow.getAttribute('aria-selected'), 'true');
  assert.equal(panel.querySelector('#studio-view-follow').hidden, true);
  assert.equal(queue.children.length, 0);
  assert.match(results.textContent, /unfollow_target/);
  assert.match(panel.querySelector('[data-manual] textarea').value, /unfollow_target/);
  follow.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.querySelector('#studio-view-unfollow').hidden, true);
  assert.equal(results.children.length, 0);
  assert.match(queue.textContent, /follow_target/);
});

test('follow worker verifies stable Turkish/English states and retries at most once', async t => {
  async function fixture({initial = 'Takip et', afterClick, heading = true, dialog = false, cancelled = false, afterReload}) {
    const dom = new JSDOM('<main><section><div>' + (heading ? '<h2>candidate</h2>' : '') +
      '<div role="button" aria-label="' + initial + '"><span>' + initial + '</span></div></div>' +
      '</section><aside><button>Follow</button></aside></main>', {runScripts: 'outside-only'});
    t.after(() => dom.window.close());
    const {window: w} = dom;
    let now = 0, attempts = 0, clicks = 0, outcome, phase, code;
    w.Date.now = () => now;
    w.setTimeout = (callback, ms) => { now += ms; return setImmediate(callback); };
    const headingElement = w.document.querySelector('h2');
    if (headingElement) headingElement.getClientRects = () => [{}];
    const button = w.document.querySelector('[role="button"]');
    const setLabel = label => { button.setAttribute('aria-label', label); button.textContent = label; };
    let clickedAt = -1;
    button.getClientRects = () => {
      if (phase === 'verifying' && afterReload) setLabel(afterReload);
      else if (clickedAt >= 0 && afterClick) setLabel(afterClick(clicks, now - clickedAt));
      return [{}];
    };
    let suggestionClicks = 0;
    const suggestion = w.document.querySelector('aside button');
    suggestion.getClientRects = () => [{}];
    suggestion.onclick = () => suggestionClicks++;
    button.onclick = () => {
      clicks++;
      clickedAt = now;
      if (dialog) w.document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Try again later</div>');
    };
    w.chrome = {runtime: {async sendMessage(message) {
      if (message.type === 'follow-check') return {ok: true, name: 'candidate', attempts, phase};
      if (message.type === 'follow-attempt') {
        if (cancelled) return {ok: false, error: 'Stopped'};
        attempts++;
        return {ok: true, name: 'candidate', attempts};
      }
      if (message.type === 'follow-verify') { phase = 'verifying'; return {ok: true}; }
      outcome = message.outcome;
      code = message.code;
      return {ok: true};
    }}};
    w.eval(read('i18n.js'));
    w.eval(read('follow-content.js'));
    await w.eval("FollowStudioQueue.work('fixture')");
    if (phase === 'verifying') await w.eval("FollowStudioQueue.work('fixture')");
    assert.equal(suggestionClicks, 0);
    return {clicks, outcome, now, code};
  }

  for (const label of ['Following', 'Takiptesin', 'Takip ediliyor', 'Requested', 'İstek Gönderildi', 'Takip isteği gönderildi']) {
    const result = await fixture({afterClick: () => label});
    assert.equal(result.clicks, 1, label);
    assert.equal(result.outcome, ['Requested', 'İstek Gönderildi', 'Takip isteği gönderildi'].includes(label) ? 'requested' : 'followed', label);
    assert.ok(result.now >= 3500);
  }
  const preexisting = await fixture({initial: 'Requested'});
  assert.equal(preexisting.clicks, 0);
  assert.equal(preexisting.outcome, 'requested');

  const retry = await fixture({afterClick: (clicks, elapsed) =>
    clicks === 1 ? (elapsed < 2000 ? 'Following' : 'Follow') : 'Requested'});
  assert.equal(retry.clicks, 2);
  assert.equal(retry.outcome, 'requested');
  assert.ok(retry.now >= 7000);

  const rejected = await fixture({afterClick: (_, elapsed) => elapsed < 2000 ? 'Following' : 'Follow'});
  assert.equal(rejected.clicks, 2);
  assert.equal(rejected.outcome, 'unverified');
  assert.equal(rejected.code, 'rejected');

  const reverted = await fixture({afterClick: () => 'Following', afterReload: 'Follow'});
  assert.equal(reverted.clicks, 1);
  assert.equal(reverted.outcome, 'unverified');
  assert.equal(reverted.code, 'verification_failed');

  const blocked = await fixture({dialog: true});
  assert.equal(blocked.clicks, 1);
  assert.equal(blocked.outcome, 'unverified');
  const missing = await fixture({heading: false});
  assert.equal(missing.clicks, 0);
  assert.equal(missing.outcome, 'unverified');
  const stopped = await fixture({cancelled: true});
  assert.equal(stopped.clicks, 0);
});

test('follow attempt budget survives worker reloads and rejects immediate repeat clicks', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment();
  await env.send({type: 'follow-add'}, 1, 0, 'https://www.instagram.com/candidate/');
  await env.send({type: 'follow-start', settings: {min: 1, max: 1, batch: 10, rest: 15}});
  env.local[key].next = 1;
  env.alarms[0]({name: 'follow-studio-next-follow'});
  await env.send({type: 'studio-ready'});
  const {job} = env.local[key];
  const request = () => env.send({type: 'follow-attempt', id: job.id}, job.tabId, 0, job.url);
  assert.equal((await request()).attempts, 1);
  assert.equal((await request()).ok, false);
  env.local[key].job.lastAttemptAt = Date.now() - 4000;
  assert.equal((await request()).attempts, 2);
  env.local[key].job.lastAttemptAt = Date.now() - 4000;
  assert.equal((await request()).ok, false);
  const check = await env.send({type: 'follow-check', id: job.id}, job.tabId, 0, job.url);
  assert.equal(check.attempts, 2);
  await env.send({type: 'follow-result', id: job.id, outcome: 'follow'}, job.tabId, 0, job.url);
  assert.equal(env.local[key].running, false);
  assert.match(env.local[key].failed[0].reason, /İki deneme/);
});

test('follow queue stops on account change and only its original account can resume', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment();
  const settings = {min: 1, max: 1, batch: 10, rest: 15};
  await env.send({type: 'follow-add'}, 1, 0, 'https://www.instagram.com/candidate/');
  await env.send({type: 'follow-start', settings});
  assert.deepEqual(env.local[key].account, {id: '1001', storeId: '0'});
  env.setAccount('2002', true);
  await env.send({type: 'studio-ready'});
  assert.equal(env.local[key].running, false);
  assert.deepEqual(env.local[key].queue, ['candidate']);
  assert.equal((await env.send({type: 'follow-start', settings})).ok, false);
  env.setAccount('1001');
  assert.equal((await env.send({type: 'follow-start', settings})).ok, true);
});

test('account guards reject clicks and results even if a cookie change notification was missed', async () => {
  const key = 'follow-studio-follow-queue';
  const settings = {min: 1, max: 1, batch: 10, rest: 15};
  for (const phase of ['alarm', 'follow-check', 'follow-attempt', 'follow-result']) {
    const env = environment();
    await env.send({type: 'follow-add'}, 1, 0, 'https://www.instagram.com/candidate/');
    await env.send({type: 'follow-start', settings});
    env.local[key].next = 1;
    if (phase === 'alarm') {
      env.setAccount('2002');
      env.alarms[0]({name: 'follow-studio-next-follow'});
      await env.send({type: 'studio-ready'});
      assert.equal(env.tabs.size, 2);
    } else {
      env.alarms[0]({name: 'follow-studio-next-follow'});
      await env.send({type: 'studio-ready'});
      const {job} = env.local[key];
      env.setAccount('2002');
      const response = await env.send({type: phase, id: job.id, outcome: 'followed'}, job.tabId, 0, job.url);
      assert.equal(response.ok, false, phase);
      assert.equal(env.tabs.has(job.tabId), false);
    }
    assert.equal(env.local[key].running, false, phase);
    assert.deepEqual(env.local[key].queue, ['candidate']);
    assert.equal(env.local[key].history.length, 0);
    assert.equal(env.local[key].failed?.length || 0, 0);
  }
});

test('missing identity, logout, cookie store mismatch and older unbound runs stop safely', async () => {
  const key = 'follow-studio-follow-queue';
  const settings = {min: 1, max: 1, batch: 10, rest: 15};
  const env = environment();
  await env.send({type: 'follow-add'}, 1, 0, 'https://www.instagram.com/candidate/');
  env.setAccount(null);
  assert.equal((await env.send({type: 'follow-start', settings})).ok, false);
  env.setAccount('1001');
  await env.send({type: 'follow-start', settings});
  env.setStore('1');
  await env.send({type: 'follow-stop'});
  assert.equal((await env.send({type: 'follow-start', settings})).ok, false);
  env.setStore('0');
  await env.send({type: 'follow-start', settings});
  env.setAccount(null, true);
  await env.send({type: 'studio-ready'});
  assert.equal(env.local[key].running, false);
  assert.deepEqual(env.local[key].queue, ['candidate']);

  const old = environment({[key]: {queue: ['legacy'], history: [], running: true, next: 1}});
  old.alarms[0]({name: 'follow-studio-next-follow'});
  await old.send({type: 'studio-ready'});
  assert.equal(old.local[key].running, false);
  assert.deepEqual(old.local[key].queue, ['legacy']);
  assert.equal(old.tabs.size, 2);
});

test('history duplicate protection covers profile buttons and bulk import including older records', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment({[key]: {queue: [], history: [
    {name: 'completed', outcome: 'followed', time: 1},
    {name: 'requested', outcome: 'requested', time: 2}
  ], running: false}});
  const response = await env.send({type: 'follow-add'}, 1, 0, 'https://www.instagram.com/completed/');
  assert.equal(response.ok, false);
  assert.match(response.error, /daha önce/);
  const bulk = await env.send({type: 'follow-add-list', text: ['@Completed', 'requested', 'fresh'].join('\n')});
  assert.deepEqual(structuredClone(bulk.counts), {added: 1, duplicate: 0, held: 0, completed: 2, invalid: 0});
  assert.deepEqual(env.local[key].queue, ['fresh']);
});

test('failure records and total attempt counts survive manual requeue and restarting a run', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment();
  const settings = {min: 1, max: 1, batch: 10, rest: 15};
  await env.send({type: 'follow-add'}, 1, 0, 'https://www.instagram.com/candidate/');
  const run = async () => {
    await env.send({type: 'follow-start', settings});
    env.local[key].next = 1;
    env.alarms[0]({name: 'follow-studio-next-follow'});
    await env.send({type: 'studio-ready'});
    return env.local[key].job;
  };
  let job = await run();
  const send = message => env.send({id: job.id, ...message}, job.tabId, 0, job.url);
  await send({type: 'follow-attempt'});
  env.local[key].job.lastAttemptAt = Date.now() - 4000;
  await send({type: 'follow-attempt'});
  await send({type: 'follow-result', outcome: 'unverified', code: 'rejected'});
  assert.equal(env.local[key].failed[0].totalAttempts, 2);
  assert.equal(env.local[key].failed[0].code, 'rejected');
  assert.ok(env.local[key].failed[0].lastAttemptAt);
  await env.send({type: 'follow-requeue', name: 'candidate'});
  job = await run();
  assert.equal(env.local[key].attemptLog.length, 2);
  await send({type: 'follow-attempt'});
  await send({type: 'follow-verify', outcome: 'requested'});
  assert.equal((await send({type: 'follow-result', outcome: 'requested'})).ok, false);
  await send({type: 'follow-check'});
  await send({type: 'follow-result', outcome: 'requested'});
  assert.equal(env.local[key].history[0].totalAttempts, 3);
  assert.equal(env.local[key].failures.length, 1);
  assert.equal(env.local[key].failures[0].code, 'rejected');
  assert.equal(env.local[key].attemptLog.length, 3);
});

test('verification reload cannot click again or complete from the original document', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment();
  await env.send({type: 'follow-add-list', text: ['candidate', 'remaining'].join('\n')});
  await env.send({type: 'follow-start', settings: {min: 1, max: 1, batch: 10, rest: 15}});
  env.local[key].next = 1;
  env.alarms[0]({name: 'follow-studio-next-follow'});
  await env.send({type: 'studio-ready'});
  const job = env.local[key].job;
  const send = message => env.send({id: job.id, ...message}, job.tabId, 0, job.url);
  assert.equal((await send({type: 'follow-result', outcome: 'followed'})).ok, false);
  await send({type: 'follow-verify', outcome: 'followed'});
  assert.equal((await send({type: 'follow-attempt'})).ok, false);
  assert.equal((await send({type: 'follow-result', outcome: 'followed'})).ok, false);
  assert.equal(env.local[key].history.length, 0);
  await send({type: 'follow-check'});
  await send({type: 'follow-result', outcome: 'unverified', code: 'verification_failed'});
  assert.equal(env.local[key].running, false);
  assert.deepEqual(env.local[key].queue, ['remaining']);
  assert.equal(env.local[key].history.length, 0);
  assert.equal(env.local[key].failed[0].code, 'verification_failed');
});

test('registered workers log login redirects distinctly without touching remaining profiles', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment();
  await env.send({type: 'follow-add-list', text: ['candidate', 'remaining'].join('\n')});
  await env.send({type: 'follow-start', settings: {min: 1, max: 1, batch: 10, rest: 15}});
  env.local[key].next = 1;
  env.alarms[0]({name: 'follow-studio-next-follow'});
  await env.send({type: 'studio-ready'});
  const {job} = env.local[key];
  const response = await env.send({type: 'follow-result', id: job.id, outcome: 'unverified', code: 'login_required'},
    job.tabId, 0, 'https://www.instagram.com/accounts/login/');
  assert.equal(response.ok, true);
  assert.equal(env.local[key].running, false);
  assert.equal(env.local[key].failures[0].code, 'login_required');
  assert.deepEqual(env.local[key].queue, ['remaining']);
});

test('failure details and retained logs are visible without mixing them into successful history', async t => {
  const env = environment({'follow-studio-follow-queue': {queue: [], history: [], failed: [
    {name: 'candidate', reason: 'Profilde takip düğmesi bulunamadı.', code: 'button_missing',
      totalAttempts: 3, lastAttemptAt: 1000, time: 2000}],
    failures: [{name: 'candidate', reason: 'Profilde takip düğmesi bulunamadı.', code: 'button_missing',
      totalAttempts: 3, lastAttemptAt: 1000, time: 2000}]}});
  const {dom, panel} = await app(env);
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(panel.querySelector('[data-follow-failed]').textContent, /Toplam 3 deneme/);
  assert.match(panel.querySelector('[data-follow-failed]').textContent, /Son deneme/);
  const errors = panel.querySelector('[data-failure-log-section]');
  errors.open = true;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(panel.querySelector('[data-follow-errors]').textContent, /takip düğmesi bulunamadı/);
  assert.match(panel.querySelector('[data-follow-errors]').textContent, /Toplam 3 deneme/);
});

test('remaining list export pauses the source and imports on another computer without duplicates', async t => {
  const key = 'follow-studio-follow-queue';
  const source = environment({[key]: {queue: ['remaining_one', 'remaining_two'], history: [
    {name: 'completed', outcome: 'followed', time: 1}], failed: [
    {name: 'failed', reason: 'Takip doğrulanamadı.', time: 1}], running: true}});
  const from = await app(source);
  t.after(() => from.dom.window.close());
  let clipboard = '';
  Object.defineProperty(from.w.navigator, 'clipboard', {value: {
    async writeText(text) { clipboard = text; }
  }});
  await from.panel.querySelector('[data-follow-copy]').onclick();
  assert.equal(clipboard, ['@remaining_one', '@remaining_two'].join('\n'));
  assert.equal(source.local[key].running, false);
  assert.deepEqual(source.local[key].queue, ['remaining_one', 'remaining_two']);
  assert.equal(source.local[key].history.length, 1);
  assert.equal(source.local[key].failed.length, 1);

  const destination = environment({[key]: {queue: ['remaining_one'], history: [], running: false}});
  const to = await app(destination);
  t.after(() => to.dom.window.close());
  Object.defineProperty(to.w.navigator, 'clipboard', {value: {async readText() { return clipboard; }}});
  await to.panel.querySelector('[data-follow-paste]').onclick();
  assert.deepEqual(destination.local[key].queue, ['remaining_one']);
  await to.panel.querySelector('[data-follow-add-list]').onsubmit({preventDefault() {}});
  assert.deepEqual(destination.local[key].queue, ['remaining_one', 'remaining_two']);
  assert.equal(destination.local[key].running, false);
});

test('clipboard permission failure leaves a selectable remaining list and manual paste available', async t => {
  const key = 'follow-studio-follow-queue';
  const env = environment({[key]: {queue: ['remaining'], history: [], running: false}});
  const {dom, w, panel} = await app(env);
  t.after(() => dom.window.close());
  Object.defineProperty(w.navigator, 'clipboard', {value: {
    async writeText() { throw new Error('Denied'); },
    async readText() { throw new Error('Denied'); }
  }});
  const field = panel.querySelector('[data-follow-add-list] textarea');
  await panel.querySelector('[data-follow-copy]').onclick();
  assert.equal(field.value, '@remaining');
  assert.equal(field.selectionStart, 0);
  assert.equal(field.selectionEnd, field.value.length);
  assert.match(panel.querySelector('[data-follow-import-result]').textContent, /Ctrl\+C/);
  await panel.querySelector('[data-follow-paste]').onclick();
  assert.equal(field.value, '@remaining');
  assert.match(panel.querySelector('[data-follow-import-result]').textContent, /Ctrl\+V/);
});

async function relationshipArchive(env, followers, following, at) {
  return env.send({type: 'relationships-import', username: 'owner',
    expectedAccount: {id: '1001', storeId: '0'}, allTime: true, at, followers, following});
}

test('archive snapshots compare dated follower and mutual losses', async () => {
  const env = environment();
  const initial = Date.now() - 86400000;
  assert.equal((await relationshipArchive(env, ['alice', 'bob', 'carol'], ['alice', 'bob'], initial)).ok, true);
  assert.equal((await relationshipArchive(env, ['bob', 'carol'], ['carol'], initial + 1)).changes, 2);
  assert.equal((await relationshipArchive(env, ['bob', 'carol'], ['carol'], initial + 2)).changes, 0);
  const saved = env.local[relationshipsKey].accounts[0];
  const [alice, bob] = saved.events;
  assert.equal(alice.name, 'alice');
  assert.equal(alice.type, 'lost_follower');
  assert.equal(alice.wasMutual, true);
  assert.equal(bob.name, 'bob');
  assert.equal(bob.type, 'mutual_ended');
  assert.equal(alice.from, initial);
  assert.equal(alice.to, initial + 1);
  assert.equal(saved.scans.length, 3);
});

test('extension cancels a legacy automatic scan and cannot start or resume one', async () => {
  const profile = 'https://www.instagram.com/owner/?follow_studio_scan=old-scan';
  const scanKey = 'follow-studio-relationship-job';
  const env = environment({[scanKey]: {id: 'old-scan', account: {id: '1001', storeId: '0'}, username: 'owner',
    running: true, tabId: 3, url: profile}});
  env.tabs.set(3, {id: 3, url: profile});
  assert.equal((await env.send({type: 'studio-ready'})).ok, true);
  assert.equal(env.local[scanKey].running, false);
  assert.equal(env.tabs.has(3), false);
  for (const type of ['relationships-start', 'relationships-resume', 'relationships-check',
    'relationships-progress', 'relationships-result']) {
    assert.equal((await env.send({type, username: 'owner'})).ok, false);
  }
  assert.equal(env.tabs.size, 2);
  assert.equal(env.local[relationshipsKey], undefined);
});

test('relationship recording fails without replacing a valid baseline if storage is full', async () => {
  const env = environment();
  const initial = Date.now() - 1000;
  assert.equal((await relationshipArchive(env, ['alice'], ['alice'], initial)).ok, true);
  const original = structuredClone(env.local[relationshipsKey]);
  const save = env.storage.local.set;
  env.storage.local.set = async values => {
    if (relationshipsKey in values) throw new Error('Quota exceeded');
    return save(values);
  };
  assert.equal((await relationshipArchive(env, [], [], initial + 1)).ok, false);
  assert.deepEqual(env.local[relationshipsKey], original);
});

test('relationship history tab shows comparison intervals and keeps other tools hidden', async t => {
  const env = environment();
  const initial = Date.now() - 1000;
  await relationshipArchive(env, ['alice', 'bob'], ['alice', 'bob'], initial);
  await relationshipArchive(env, ['bob'], [], initial + 1);
  const {dom, panel} = await app(env);
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  panel.querySelector('#studio-tab-relationships').click();
  await new Promise(resolve => setImmediate(resolve));
  const view = panel.querySelector('#studio-view-relationships');
  assert.equal(view.hidden, false);
  assert.equal(panel.querySelector('#studio-view-follow').hidden, true);
  assert.equal(panel.querySelector('#studio-view-unfollow').hidden, true);
  assert.equal(view.querySelector('[data-relationship-import] button').textContent, 'Arşivi kaydet ve karşılaştır');
  assert.match(view.querySelector('[data-relationship-events]').textContent, /alice/);
  assert.match(view.querySelector('[data-relationship-events]').textContent, /Önceki kontrol/);
  assert.match(view.querySelector('[data-relationship-events]').textContent, /Değişimin görüldüğü kontrol/);
  assert.equal(view.querySelector('[data-relationship-scans]').children.length, 2);
});

test('relationship username is detected when the profile loads after content script initialization', async t => {
  const env = environment();
  const {dom, w, panel} = await app(env, 'https://www.instagram.com/owner/');
  t.after(() => dom.window.close());
  assert.equal(panel.querySelector('[data-relationship-import] input[name=username]').value, '');
  w.document.body.insertAdjacentHTML('afterbegin', '<main><h2>owner</h2><a href="/accounts/edit/">Edit profile</a></main>');
  w.document.querySelector('main a').getClientRects = () => [{}];
  panel.querySelector('[data-open]').click();
  panel.querySelector('#studio-tab-relationships').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.querySelector('[data-relationship-import] input[name=username]').value, 'owner');
});

test('relationship ZIP import compares complete archives using their supplied dates and preserves other tools', async t => {
  const env = environment({[cacheKey]: {filename: 'unchanged.zip', items: []}});
  const {dom, w, panel} = await app(env);
  t.after(() => dom.window.close());
  panel.querySelector('[data-open]').click();
  panel.querySelector('#studio-tab-relationships').click();
  await new Promise(resolve => setImmediate(resolve));
  panel.querySelector('[data-relationship-import] input[name=username]').value = 'owner';
  const form = panel.querySelector('[data-relationship-import]');
  form.elements.allTime.checked = true;
  const user = name => ({string_list_data: [{value: name}]});
  const submit = async (files, date) => {
    Object.defineProperty(form.elements.archive, 'files', {configurable: true,
      value: [new w.File([zipJson(files)], 'synthetic-relationships.zip')]});
    form.elements.archiveDate.value = date;
    await form.onsubmit({preventDefault() {}});
  };
  await submit({'followers_1.json': [user('alice'), user('bob')],
    'followers_2.json': [user('carol')],
    'following.json': {relationships_following: [user('alice'), user('bob')]}}, '2026-01-01T12:00');
  const first = env.local['follow-studio-relationships'].accounts[0];
  assert.deepEqual(first.latest.followers, ['alice', 'bob', 'carol']);
  assert.equal(first.latest.source, 'archive');
  assert.equal(first.latest.at, new Date('2026-01-01T12:00').getTime());
  await submit({'followers_1.json': [user('bob'), user('carol')],
    'following.json': {relationships_following: [user('carol')]}}, '2026-01-02T12:00');
  const second = env.local['follow-studio-relationships'].accounts[0];
  assert.equal(second.events.length, 2);
  assert.equal(second.events[0].from, first.latest.at);
  assert.equal(second.events[0].to, new Date('2026-01-02T12:00').getTime());
  assert.equal(second.scans.length, 2);
  assert.equal(env.local[cacheKey].filename, 'unchanged.zip');
  const original = structuredClone(env.local['follow-studio-relationships']);
  await submit({'followers_1.json': [user('bob')], 'followers_3.json': [user('carol')],
    'following.json': []}, '2026-01-03T12:00');
  assert.deepEqual(env.local['follow-studio-relationships'], original);
  assert.match(form.querySelector('[data-relationship-import-status]').textContent, /parçaları eksik/);
});

test('archive snapshots reject stale dates, missing all-time confirmation and account changes', async () => {
  const env = environment();
  const request = {type: 'relationships-import', username: 'owner', expectedAccount: {id: '1001', storeId: '0'},
    at: Date.now() - 100000, followers: ['alice'], following: ['alice'], allTime: true};
  assert.equal((await env.send({...request, allTime: false})).ok, false);
  assert.equal((await env.send(request)).ok, true);
  const original = structuredClone(env.local['follow-studio-relationships']);
  assert.equal((await env.send({...request, at: request.at - 1000, followers: []})).ok, false);
  assert.deepEqual(env.local['follow-studio-relationships'], original);
  env.setAccount('2002');
  assert.equal((await env.send({...request, at: Date.now() - 50000})).ok, false);
  assert.deepEqual(env.local['follow-studio-relationships'], original);
});

async function startFollowFixture(env, names = ['candidate', 'remaining']) {
  const settings = {min: 1, max: 1, batch: 10, rest: 15};
  await env.send({type: 'follow-add-list', text: names.join('\n')});
  assert.equal((await env.send({type: 'follow-start', settings})).ok, true);
  env.local['follow-studio-follow-queue'].next = 1;
  env.alarms[0]({name: 'follow-studio-next-follow'});
  await env.send({type: 'studio-ready'});
  const job = env.local['follow-studio-follow-queue'].job;
  return {job, send: message => env.send({id: job.id, ...message}, job.tabId, 0, job.url)};
}

test('session limit stops without removing remaining profiles and does not resume on an alarm', async () => {
  const env = environment();
  await env.send({type: 'follow-add-list', text: 'candidate\nremaining'});
  const settings = {min: 5, max: 5, batch: 5, rest: 30, limit: 1};
  assert.equal((await env.send({type: 'follow-start', settings: {...settings, limit: 0}})).ok, false);
  assert.equal((await env.send({type: 'follow-start', settings})).ok, true);
  const key = 'follow-studio-follow-queue';
  env.local[key].next = 1;
  env.alarms[0]({name: 'follow-studio-next-follow'});
  await env.send({type: 'studio-ready'});
  const job = env.local[key].job;
  await env.send({type: 'follow-result', id: job.id, outcome: 'unverified', code: 'button_missing'}, job.tabId, 0, job.url);
  assert.equal(env.local[key].running, false);
  assert.deepEqual(env.local[key].queue, ['remaining']);
  assert.match(env.local[key].status, /Oturum sınırına/);
  await env.flushPower();
  assert.equal(env.powerCalls.at(-1), 'release');
  env.alarms[0]({name: 'follow-studio-next-follow'});
  await env.send({type: 'studio-ready'});
  assert.equal(env.local[key].job, null);
  assert.equal(env.tabs.size, 2);
});

test('missing buttons and unavailable pages before any click skip only that profile and advance normally', async () => {
  const key = 'follow-studio-follow-queue';
  for (const code of ['button_missing', 'page_unavailable', 'timeout']) {
    const env = environment();
    const {job, send} = await startFollowFixture(env);
    if (code === 'timeout') {
      env.local[key].next = 1;
      env.alarms[0]({name: 'follow-studio-next-follow'});
      await env.send({type: 'studio-ready'});
    } else await send({type: 'follow-result', outcome: 'unverified', code});
    assert.equal(env.local[key].running, true, code);
    assert.deepEqual(env.local[key].queue, ['remaining']);
    assert.equal(env.local[key].failed[0].name, 'candidate');
    assert.equal(env.local[key].failed[0].skipped, true);
    assert.equal(env.local[key].history.length, 0);
    assert.equal(env.local[key].job, null);
    assert.ok(env.local[key].next > Date.now());
    assert.equal(env.tabs.has(job.tabId), false);
    env.local[key].next = 1;
    env.alarms[0]({name: 'follow-studio-next-follow'});
    await env.send({type: 'studio-ready'});
    assert.equal(env.local[key].job.name, 'remaining');
  }
});

test('missing buttons after a click or during verification skip the profile without recording success', async () => {
  for (const phase of ['clicked', 'verifying']) {
    const env = environment();
    const {send} = await startFollowFixture(env);
    if (phase === 'clicked') await send({type: 'follow-attempt'});
    else await send({type: 'follow-verify', outcome: 'requested'});
    await send({type: 'follow-result', outcome: 'unverified', code: 'button_missing'});
    const state = env.local['follow-studio-follow-queue'];
    assert.equal(state.running, true);
    assert.deepEqual(state.queue, ['remaining']);
    assert.equal(state.failed[0].skipped, true);
    assert.equal(state.history.length, 0);
    assert.ok(state.next > Date.now());
  }
});

test('verification failure and Instagram restrictions still stop the queue', async () => {
  const key = 'follow-studio-follow-queue';
  for (const scenario of ['clicked', 'verifying', 'action_blocked', 'challenge_required', 'login_required']) {
    const env = environment();
    const {send} = await startFollowFixture(env);
    if (scenario === 'clicked') await send({type: 'follow-attempt'});
    if (scenario === 'verifying') await send({type: 'follow-verify', outcome: 'requested'});
    await send({type: 'follow-result', outcome: 'unverified',
      code: ['clicked', 'verifying'].includes(scenario) ? 'verification_failed' : scenario});
    assert.equal(env.local[key].running, false, scenario);
    assert.deepEqual(env.local[key].queue, ['remaining']);
    assert.equal(env.local[key].failed[0].skipped, false);
  }
});

test('skip handling preserves the queue on an account change and finishes safely when no profiles remain', async () => {
  const key = 'follow-studio-follow-queue';
  const env = environment();
  const {send} = await startFollowFixture(env);
  env.setAccount('2002');
  await send({type: 'follow-result', outcome: 'unverified', code: 'button_missing'});
  assert.equal(env.local[key].running, false);
  assert.deepEqual(env.local[key].queue, ['candidate', 'remaining']);
  assert.equal(env.local[key].failed?.length || 0, 0);
  const last = environment();
  const fixture = await startFollowFixture(last, ['candidate']);
  await fixture.send({type: 'follow-result', outcome: 'unverified', code: 'button_missing'});
  assert.equal(last.local[key].running, false);
  assert.deepEqual(last.local[key].queue, []);
  assert.equal(last.local[key].failed[0].skipped, true);
  assert.equal(last.local[key].history.length, 0);
});

test('follow control ignores hidden headings and collapses nested duplicate controls inside the profile header', async t => {
  const dom = new JSDOM('<main><header><h2 hidden>candidate</h2><div><h2>candidate</h2><button hidden>Follow</button></div>' +
    '<div role="button"><button>Follow</button></div></header><aside><button>Follow</button></aside></main>',
    {runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function() { return this.closest('[hidden]') ? [] : [{}]; };
  let now = 0, attempts = 0, phase, outcome;
  w.Date.now = () => now;
  w.setTimeout = (fn, ms) => { now += ms; return setImmediate(fn); };
  let profileClicks = 0, suggestionClicks = 0;
  w.document.querySelector('header [role="button"] button').onclick = event => { profileClicks++; event.target.textContent = 'Requested'; };
  w.document.querySelector('aside button').onclick = () => suggestionClicks++;
  w.chrome = {runtime: {async sendMessage(message) {
    if (message.type === 'follow-check') return {ok: true, name: 'candidate', attempts, phase};
    if (message.type === 'follow-attempt') { attempts++; return {ok: true, name: 'candidate', attempts}; }
    if (message.type === 'follow-verify') { phase = 'verifying'; return {ok: true}; }
    outcome = message.outcome;
    return {ok: true};
  }}};
  w.eval(read('i18n.js'));
  w.eval(read('follow-content.js'));
  await w.eval("FollowStudioQueue.work('fixture')");
  await w.eval("FollowStudioQueue.work('fixture')");
  assert.equal(profileClicks, 1);
  assert.equal(suggestionClicks, 0);
  assert.equal(outcome, 'requested');
});
