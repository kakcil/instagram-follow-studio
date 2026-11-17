const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).version;
let source = fs.readFileSync(path.join(root, 'instagram-follow-studio.user.js'), 'utf8').replace(/\r\n/g, '\n');
source = source.slice(source.indexOf('(async () => {'));
const replace = (before, after) => {
  if (!source.includes(before)) throw new Error('Shared source changed: ' + before.slice(0, 70));
  source = source.replace(before, after);
};
replace("  const localize = value => value;\n  const locale = () => 'tr-TR';",
  '  const {text: localize, locale} = FollowStudioI18n;');
replace('  const profileDetails = item => ({photo: item.photoUrl, followedAt: item.timestamp * 1000 || 0});', `  let profileData = {};
  const profileDetails = item => ({
    photo: profileData.photos?.[item.name] || item.photoUrl,
    followedAt: Math.max(item.timestamp * 1000 || 0, profileData.followedAt?.[item.name] || 0)
  });`);
replace("  'use strict';", "  'use strict';\n  if (window.top === window.self && /^\\/direct\\/t\\/\\d+\\/?$/.test(location.pathname)) {\n    const dm = await chrome.runtime.sendMessage({type: 'dm-resume'});\n    if (dm?.ok && dm.id) { await FollowStudioMessages.work(dm.id, dm.thread); return; }\n  }\n  const followId = new URL(location.href).searchParams.get('follow_studio_job');\n  if (followId) { if (window.top === window.self) await FollowStudioQueue.work(followId); return; }\n  if (window.top !== window.self && !new URL(location.href).searchParams.has('local_unfollow_job')) return;\n  const bridge = await FollowStudioBridge.connect();\n  const {getValue: storageGet, setValue: storageSet, deleteValue: storageDelete} = bridge;");
source = source.replaceAll('GM_getValue', 'storageGet').replaceAll('GM_setValue', 'storageSet').replaceAll('GM_deleteValue', 'storageDelete');

const workerStart = source.indexOf('    const active = () => {');
const workerEnd = source.indexOf("    let stage = 'profile';", workerStart);
if (workerStart < 0 || workerEnd < 0) throw new Error('Worker boundary changed');
source = source.slice(0, workerStart) + `    const active = () => bridge.checkJob(username, token);
    const progress = async text => {
      const current = await active();
      storageSet(key, {...current, progress: text});
      await bridge.flush();
    };
` + source.slice(workerEnd);
replace("      progress('Profil düğmesi bekleniyor');", "      await progress('Profil düğmesi bekleniyor');");
source = source.replaceAll('      active();', '      await active();');
replace("        progress('Following menüsü açılıyor');", "        await progress('Following menüsü açılıyor');");
replace("        progress('Takip bırakılıyor, sonuç bekleniyor');", "        await progress('Takip bırakılıyor, sonuç bekleniyor');");
replace("state: stage === 'profile' ? 'skipped' : 'error', outcome: stage === 'profile' ? 'not_found' : 'error', message: `${username}: ${stage === 'profile' ? 'profil düğmesi 2 saniyede bulunamadı; atlandı' : error.message}`", "state: (error.outcome || stage === 'profile') ? 'skipped' : 'error', outcome: error.outcome || (stage === 'profile' ? 'not_found' : 'error'), message: `${username}: ${error.outcome ? error.message : stage === 'profile' ? 'profil düğmesi 2 saniyede bulunamadı; atlandı' : error.message}`");
replace('    return;\n  }\n\n  if (window.top', '    await bridge.flush();\n    return;\n  }\n\n  if (window.top');
replace('    const closeWorker = () => {\n      if (handle) { try { handle.close(); } catch (error) {} handle = null; }\n    };',
  '    const closeWorker = async () => {\n      if (handle) { try { await handle.close(); } catch (error) {} handle = null; }\n    };');
replace("        storageSet(key, {id, username, state: 'running', progress: ''});", "        storageSet(key, {id, username, state: 'running', progress: ''});\n        await bridge.flush();");
replace('handle = GM_openInTab(url, {active: false, insert: true, setParent: true});', 'handle = await bridge.openTab(url);');
replace('        closeWorker();', '        await bridge.flush();\n        await closeWorker();');
replace('    } finally { closeWorker(); }', '    } finally { await closeWorker(); }');
replace('  start.onclick = async () => {\n    if (running) return;', `  start.onclick = async () => {
    if (running) return;
    const activity = panel.querySelector('.activity');
    activity.closest('.studio-unfollow-options').open = true;
    activity.open = true;`);
replace("        : [...new Set(panel.querySelector('textarea').value",
  "        : !panel.querySelector('[data-manual]').open\n          ? queueItems().map(item => item.name)\n          : [...new Set(panel.querySelector('textarea').value");
replace("    if (runList === 'queue') {", `    queueStatus.textContent = '';
    try {
      if (!await bridge.claim()) throw new Error('Başka bir Instagram sekmesinde işlem sürüyor. Önce oradaki işlemi durdur.');
    } catch (error) {
      queueStatus.textContent = localize(error.message);
      report(error.message);
      return;
    }
    if (runList === 'queue') {`);
replace('        const operationStart = Date.now();', `        try {
          await bridge.verifyCandidate(username);
        } catch (error) {
          if (!error.outcome) throw error;
          report(\`\${username}: \${error.message}\`);
          completed++; recordOutcome({state: 'skipped', outcome: error.outcome}); updateEstimate();
          continue;
        }
        if (!running) break;
        const operationStart = Date.now();`);
replace('<div class="list" data-results role="tabpanel"></div>',
  '<p class="manual-hint">Başlat, açık listedeki ZIP adaylarını sırayla işler.</p><p class="manual-hint" data-unfollow-status role="status"></p><div class="list" data-results role="tabpanel"></div>');
replace("  const start = panel.querySelector('[data-start]');", `  const start = panel.querySelector('[data-start]');
  const queueStatus = panel.querySelector('[data-unfollow-status]');`);
replace("lockControls(); report('Çalışma sona erdi.');", "lockControls(); try { await bridge.release(); } catch (error) { report(error.message); } report('Çalışma sona erdi.');");
replace("panel.querySelector('[data-open]').onclick = () => { veil.hidden = false; refreshLists(false);", "panel.querySelector('[data-open]').onclick = () => { if (!running && !loading) { listData = storageGet('follow-studio-cache', null); runSummary = storageGet('follow-studio-run-summary', null); excluded = new Set(listData && listData.excluded || []); } veil.hidden = false; refreshLists();");
source = source.replaceAll("querySelector('input[type=number]')", "querySelector('#wait-seconds')")
  .replaceAll("querySelector('textarea')", "querySelector('[data-manual] textarea')");
const syncUnfollowInput = source.match(/^    if \(syncQueue && listData && !running\) .*$/m)[0];
replace(syncUnfollowInput + '\n', '');
replace("    const area = panel.querySelector('[data-results]');", syncUnfollowInput + "\n    const area = panel.querySelector('[data-results]');");
replace('    area.replaceChildren();', "    area.replaceChildren();\n    if (!area.closest('[data-studio-view=unfollow]:not([hidden])') || area.closest('[data-veil]').hidden) return;");
replace('role="dialog" aria-modal="true"', 'role="region"');
replace('aria-label="Modalı kapat"', 'aria-label="Paneli kapat"');
replace('<div class="brand-icon" aria-hidden="true">✦</div><div><h1 id="studio-title">Follow Studio</h1><p class="subtitle">Takip listeni düzenle. Sevdiklerini koru.</p></div>', `<h1 id="studio-title">Follow Studio <small data-studio-version style="font-size:12px;font-weight:400;color:#aaa">v${version}</small></h1>`);
replace('veil.hidden = true; panel.querySelector', "veil.hidden = true; veil.dispatchEvent(new Event('studio-visibility')); panel.querySelector");
replace('veil.hidden = false; refreshLists(); panel.querySelector', "veil.hidden = false; veil.dispatchEvent(new Event('studio-visibility')); refreshLists(); panel.querySelector");
replace("[data-open]').onclick = () => { if (!running", "[data-open]').onclick = () => { if (!veil.hidden) { closeModal(); return; } if (!running");
source = source.replace(/  veil\.onclick = [^\n]+\n/, '').replace(/    if \(event.key !== 'Tab'\) return;[\s\S]*?(?=\n  \}\);)/, '');
replace('\n})();', `\n  async function readRelationshipArchive(file) {
    const zip = await readInstagramZip(file);
    const files = Object.keys(zip.files);
    const followerFiles = files.filter(name => /(^|\\/)followers(_\\d+)?\\.json$/.test(name));
    const followingFiles = files.filter(name => /(^|\\/)following\\.json$/.test(name));
    if (!followerFiles.length || followingFiles.length !== 1) {
      throw new Error('ZIP içinde followers JSON dosyaları ve tek bir following.json bulunmalı.');
    }
    const parts = followerFiles.map(name => Number(name.match(/followers_(\\d+)\\.json$/)?.[1] || 0)).sort((a,b) => a-b);
    if ((parts.includes(0) && parts.length !== 1) ||
        (!parts.includes(0) && parts.some((part,index) => part !== index + 1))) {
      throw new Error('Takipçi dosyalarının parçaları eksik veya birden fazla hesap karışmış.');
    }
    async function namesFrom(paths, property) {
      const names = new Set();
      for (const path of paths) {
        const data = JSON.parse(await zip.files[path].async('string'));
        const rows = Array.isArray(data) ? data : data[property];
        if (!Array.isArray(rows)) throw new Error('Arşivde beklenmeyen JSON yapısı.');
        for (const row of rows) {
          const item = row.string_list_data?.[0];
          const value = item?.value || row.title || item?.href;
          if (typeof value !== 'string' || !value.trim()) throw new Error('Arşivde geçersiz kullanıcı kaydı.');
          names.add(parseName(value));
        }
      }
      return [...names];
    }
    return {followers: await namesFrom(followerFiles, 'relationships_followers'),
      following: await namesFrom(followingFiles, 'relationships_following')};
  }
  FollowStudioQueue.attach(panel, refreshLists, readRelationshipArchive);
  let profileDetailsRevision = 0;
  async function refreshProfileDetails(photos) {
    if (!photos && veil.hidden) return;
    const revision = ++profileDetailsRevision;
    try {
      const data = await bridge.profileDetails(photos);
      if (revision !== profileDetailsRevision) return;
      profileData = data;
    } catch {
      if (revision !== profileDetailsRevision) return;
      profileData = {};
    }
    if (!veil.hidden) refreshLists(false);
  }
  function photoNames() {
    return new Set([
      ...(storageGet('follow-studio-cache', null)?.items || []).map(item => item.name),
      ...Object.keys(storageGet(protectedKey, {})),
      ...Object.keys(storageGet(frozenKey, {}))
    ]);
  }
  let photoCandidates = photoNames();
  const collectLoadedPhotos = FollowStudioRelationships.observePhotos(name => photoCandidates.has(name), refreshProfileDetails);
  collectLoadedPhotos();
  veil.addEventListener('studio-visibility', () => {
    if (!veil.hidden) collectLoadedPhotos();
    void refreshProfileDetails();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes['follow-studio-cache'] || changes[protectedKey] || changes[frozenKey]) {
      photoCandidates = photoNames();
      collectLoadedPhotos();
    }
    if (veil.hidden) return;
    const history = changes['follow-studio-follow-queue'];
    if (changes['follow-studio-relationships'] || changes['follow-studio-observed-photos'] ||
        history?.oldValue?.history?.length !== history?.newValue?.history?.length) {
      void refreshProfileDetails();
    }
  });
  if (await bridge.ready()) panel.querySelector('[data-open]').click();
})().catch(error => {
  console.error('Follow Studio:', error.message);
  const host = document.querySelector('#ig-follow-manager');
  const status = host?.shadowRoot?.querySelector('[data-status]');
  if (status) status.textContent = FollowStudioI18n.text('Hata: ' + FollowStudioI18n.text(error.message));
});`);
source = '// Generated by scripts/build-extension.cjs. Edit shared source or build adapter.\n' + source;
const target = path.join(root, 'extension/content.js');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== source) throw new Error('Run npm run build');
  console.log('Extension generated source is up to date.');
} else {
  fs.writeFileSync(target, source);
  console.log('Built extension/content.js');
}
