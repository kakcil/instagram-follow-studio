const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const {randomUUID} = require('node:crypto');
const root = path.join(__dirname, '../extension');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const jobKey = 'local-unfollow-job';
const cacheKey = 'follow-studio-cache';

function environment(initial = {}) {
  const local = structuredClone(initial), session = {}, changes = [];
  const tabs = new Map([[1, {id: 1}], [2, {id: 2}]]), removed = [], updated = [];
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
  const chrome = {
    storage, runtime: {id: 'fixture-extension', onMessage: {addListener(fn) { listener = fn; }}},
    action: {onClicked: {addListener() {}}},
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error('Missing tab'); return tabs.get(id); },
      async create(options) { const tab = {id: next++, ...options}; tabs.set(tab.id, tab); created?.(tab); return tab; },
      async remove(id) { tabs.delete(id); },
      onRemoved: event(removed), onUpdated: event(updated)
    }
  };
  vm.runInNewContext(read('background.js'), {chrome, URL, console});
  const send = (message, tabId = 1, frameId = 0, url = 'https://www.instagram.com/') => new Promise(resolve => {
    listener(message, {id: chrome.runtime.id, tab: {id: tabId}, frameId, url}, resolve);
  });
  return {local, session, storage, send, tabs, updated, removed, onCreated(fn) { created = fn; }};
}

async function app(env, url = 'https://www.instagram.com/', tabId = 1) {
  const dom = new JSDOM('<html><body></body></html>', {url, runScripts: 'outside-only'});
  const w = dom.window;
  w.structuredClone = structuredClone; w.TextDecoder = TextDecoder; w.crypto.randomUUID = randomUUID;
  w.chrome = {storage: env.storage, runtime: {
    sendMessage: message => env.send(message, tabId, 0, url), onMessage: {addListener() {}}
  }};
  w.eval(read('bridge.js'));
  await w.eval(read('content.js'));
  return {dom, w, panel: w.document.querySelector('#ig-follow-manager')?.shadowRoot};
}

test('MV3 package uses only Instagram host and storage, with no userscript APIs or remote code', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://www.instagram.com/*']);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.doesNotMatch(read('content.js'), /GM_|eval\(|new Function|https:\/\/raw\.githubusercontent/);
});

test('native extension UI works without Monkey and removes successful accounts', async t => {
  const env = environment({[cacheKey]: {items: [{name: 'fixture_candidate', timestamp: 1}],
    followingNames: ['fixture_candidate', 'fixture_mutual'], followerNames: ['fixture_mutual'], followers: 1, following: 2}});
  const {dom, panel} = await app(env);
  t.after(() => dom.window.close());
  assert.equal(panel.querySelector('[data-veil]').hidden, true);
  assert.equal(panel.querySelector('input[type=number]').value, '5');
  panel.querySelector('[data-mode]').value = 'background'; panel.querySelector('input[type=number]').value = '0';
  const seen = [];
  env.onCreated(tab => {
    const job = env.local[jobKey]; seen.push(job.username);
    env.storage.local.set({[jobKey]: {...job, state: 'done', outcome: 'unfollowed', message: 'Synthetic success'}});
  });
  panel.querySelector('textarea').value = 'fixture_mutual fixture_candidate';
  await panel.querySelector('[data-start]').onclick();
  assert.deepEqual(seen, ['fixture_candidate']);
  assert.equal(env.local[cacheKey].items.length, 0);
  assert.equal(env.local['follow-studio-run-summary'].unfollowed, 1);
  assert.equal(env.session['follow-studio-session'].owner, null);
  assert.equal(env.tabs.size, 2, 'Worker tab closed');
});

test('background owns worker tabs, rejects concurrent controllers, rechecks follower/protection before clicks', async () => {
  const env = environment({[cacheKey]: {followingNames: ['fixture_candidate'], followerNames: []},
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
  assert.equal((await env.send({type: 'studio-close-worker', tabId: 2})).ok, false);
  await env.send({type: 'studio-release'});
  assert.equal(env.tabs.has(opened.tabId), false);
  assert.equal((await env.send({type: 'studio-claim'}, 2)).claimed, true);
  env.updated.forEach(fn => fn(2, {status: 'loading'}));
  assert.equal((await env.send({type: 'studio-claim'})).claimed, true, 'Reload releases owner');
});

test('storage persistence failure prevents a worker from opening', async t => {
  const env = environment({[cacheKey]: {items: [{name: 'fixture_candidate', timestamp: 1}],
    followingNames: ['fixture_candidate'], followerNames: []}});
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
