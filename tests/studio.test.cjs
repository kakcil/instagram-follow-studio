const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {JSDOM} = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../instagram-follow-studio.user.js'), 'utf8');
const cacheKey = 'follow-studio-cache';
const jobKey = 'local-unfollow-job';

function setup(store, url = 'https://www.instagram.com/') {
  const dom = new JSDOM('<html><body></body></html>', {url, runScripts: 'outside-only'});
  const w = dom.window;
  w.TextDecoder = TextDecoder;
  w.crypto.randomUUID = randomUUID;
  w.GM_getValue = (key, fallback) => structuredClone(store.has(key) ? store.get(key) : fallback);
  w.GM_setValue = (key, value) => store.set(key, structuredClone(value));
  w.GM_deleteValue = key => store.delete(key);
  w.GM_openInTab = () => { throw new Error('Real browser actions disabled in tests'); };
  w.eval(source);
  const panel = w.document.querySelector('#ig-follow-manager')?.shadowRoot;
  if (panel) {
    panel.querySelector('[data-mode]').value = 'background';
    panel.querySelector('input[type=number]').value = '0';
  }
  return {dom, w, panel};
}

// All names below are synthetic fixtures, never imported account records.
function archive(names, followers = []) {
  return {
    items: names.map((name, i) => ({name, timestamp: i + 1})),
    followingNames: names, followerNames: followers,
    followers: followers.length, following: names.length, filename: 'synthetic.zip'
  };
}

function fakeWorker(w, store, seen, outcomeFor) {
  w.GM_openInTab = (url, options) => {
    assert.equal(options.active, false);
    assert.equal(new URL(url).hostname, 'www.instagram.com');
    const job = store.get(jobKey);
    seen.push(job.username);
    const outcome = outcomeFor(job.username);
    store.set(jobKey, {...job, ...outcome, message: 'Synthetic test result'});
    return {close() {}};
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Build a valid stored ZIP entirely in memory, without private export fixtures.
function zipJson(files) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [filename, data] of Object.entries(files)) {
    const name = Buffer.from(filename), content = Buffer.from(JSON.stringify(data));
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

test('panel stays closed, default delay is five seconds, followers and protected accounts never run', async t => {
  const store = new Map([[cacheKey, archive(['fixture_mutual', 'fixture_protected', 'fixture_candidate'], ['fixture_mutual'])],
    ['follow-studio-protected', {fixture_protected: {name: 'fixture_protected'}}]]);
  const {dom, w, panel} = setup(store);
  t.after(() => dom.window.close());
  assert.equal(panel.querySelector('[data-veil]').hidden, true);
  assert.equal(panel.querySelector('[data-manual]').open, false);
  assert.match(source, /min="0" value="5"/);
  panel.querySelector('textarea').value = 'fixture_mutual fixture_protected fixture_candidate';
  const seen = [];
  fakeWorker(w, store, seen, () => ({state: 'done', outcome: 'unfollowed'}));
  await panel.querySelector('[data-start]').onclick();
  assert.deepEqual(seen, ['fixture_candidate']);
  assert.equal(store.get('follow-studio-run-summary').unfollowed, 1);
  assert.equal(store.get(cacheKey).items.length, 0);
});

test('new ZIP replaces stale data, merges follower parts, preserves protection and retry records', async t => {
  const store = new Map([[cacheKey, archive(['fixture_stale'])],
    ['follow-studio-protected', {fixture_protected: {name: 'fixture_protected'}}],
    ['follow-studio-frozen', {fixture_missing: {name: 'fixture_missing'}}]]);
  const {dom, w, panel} = setup(store);
  t.after(() => dom.window.close());
  const row = (name, timestamp) => ({title: name, string_list_data: [{value: name, timestamp}]});
  const bytes = zipJson({
    'connections/followers_and_following/followers_1.json': [row('fixture_mutual', 3)],
    'connections/followers_and_following/followers_2.json': [row('fixture_mutual_two', 4)],
    'connections/followers_and_following/following.json': {relationships_following: [
      row('fixture_mutual', 3), row('fixture_mutual_two', 4), row('fixture_new', 5)]}
  });
  const file = new w.File([bytes], 'synthetic.zip');
  await panel.querySelector('[data-zip]').onchange({target: {files: [file]}});
  assert.deepEqual(store.get(cacheKey).items.map(item => item.name), ['fixture_new']);
  assert.equal(store.get(cacheKey).followers, 2);
  assert.equal(store.get(cacheKey).following, 3);
  assert.ok(store.get('follow-studio-protected').fixture_protected);
  assert.ok(store.get('follow-studio-frozen').fixture_missing);
  assert.equal(store.get(cacheKey).followingNames.includes('fixture_stale'), false);
});

test('not-found moves to retry section, generic errors stay main, retry only processes selected section', async t => {
  const store = new Map([[cacheKey, archive(['fixture_missing', 'fixture_error', 'fixture_success'])]]);
  const {dom, w, panel} = setup(store);
  t.after(() => dom.window.close());
  const seen = [];
  fakeWorker(w, store, seen, name => name === 'fixture_missing'
    ? {state: 'skipped', outcome: 'not_found'} : name === 'fixture_error'
      ? {state: 'error', outcome: 'error'} : {state: 'done', outcome: 'unfollowed'});
  await panel.querySelector('[data-start]').onclick();
  assert.deepEqual(store.get(cacheKey).items.map(item => item.name), ['fixture_error']);
  assert.deepEqual(Object.keys(store.get('follow-studio-frozen')), ['fixture_missing']);
  panel.querySelector('[data-tab=frozen]').click();
  seen.length = 0;
  fakeWorker(w, store, seen, () => ({state: 'done', outcome: 'unfollowed'}));
  await panel.querySelector('[data-start]').onclick();
  assert.deepEqual(seen, ['fixture_missing']);
  assert.deepEqual(Object.keys(store.get('follow-studio-frozen')), []);
  assert.deepEqual(store.get(cacheKey).items.map(item => item.name), ['fixture_error']);
});

test('worker rejects a mutual follower before clicking anything', async t => {
  const store = new Map([[cacheKey, archive(['fixture_mutual'], ['fixture_mutual'])],
    [jobKey, {id: 'fixture-job', username: 'fixture_mutual', state: 'running'}]]);
  const {dom} = setup(store, 'https://www.instagram.com/fixture_mutual/?local_unfollow_job=fixture-job');
  t.after(() => dom.window.close());
  assert.equal(store.get(jobKey).state, 'skipped');
  assert.equal(store.get(jobKey).outcome, 'follower');
});
