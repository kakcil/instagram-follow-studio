'use strict';

globalThis.FollowStudioRelationships = (() => {
  const {text: localize, locale} = FollowStudioI18n;
  const stateKey = 'follow-studio-relationships';
  const jobKey = 'follow-studio-relationship-job';
  const normalize = text => (text || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/i\u0307/g, 'i');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const reserved = new Set(['accounts', 'explore', 'direct', 'reels', 'stories', 'p', 'reel', 'about', 'challenge']);
  const visible = el => el.getClientRects().length && !el.closest('[hidden],[aria-hidden="true"]');
  const fail = code => { throw Object.assign(new Error(code), {code}); };
  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({type, ...data});
    if (!response?.ok) throw new Error(response?.error || 'Tarama bağlantısı kurulamadı.');
    return response;
  }
  function usernameFromLink(link) {
    try {
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin) return;
      const name = url.pathname.match(/^\/([a-z0-9._]{1,30})\/?$/i)?.[1].toLowerCase();
      if (name && !reserved.has(name)) return name;
    } catch {}
  }
  function ownProfile(username) {
    const main = document.querySelector('main,[role="main"]');
    return main && [...main.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .some(el => normalize(el.textContent) === username) &&
      [...main.querySelectorAll('a,button,[role="button"]')].some(el => visible(el) &&
        (new URL(el.getAttribute('href') || '/', location.href).pathname.startsWith('/accounts/edit') ||
         ['edit profile', 'profili düzenle'].includes(normalize(el.textContent))));
  }
  function listLink(username, kind) {
    const main = document.querySelector('main,[role="main"]');
    if (!main) return;
    const links = [...main.querySelectorAll('a[href],button,[role="link"]')].filter(visible);
    const direct = links.filter(link => {
      const href = link.getAttribute('href');
      if (!href) return false;
      const url = new URL(href, location.href);
      return url.origin === location.origin &&
        url.pathname.toLowerCase().replace(/\/$/, '') === '/' + username + '/' + kind;
    });
    if (direct.length === 1) return direct[0];
    const names = kind === 'followers' ? ['followers', 'takipçi', 'takipçiler'] :
      ['following', 'takip', 'takip edilen', 'takip edilenler', 'takip ediliyor'];
    const labelled = links.filter(link => {
      const label = normalize(link.getAttribute('aria-label') || link.textContent)
        .replace(/\d[\d.,\s\u00a0]*\d|\d/g, '').trim();
      if (!names.includes(label)) return false;
      try { exactCount(link); return true; } catch { return false; }
    });
    if (labelled.length === 1) return labelled[0];
  }
  function exactCount(link) {
    if (!link) fail('page');
    const sources = [link, ...link.querySelectorAll('[title],[aria-label]')]
      .flatMap(el => [el.getAttribute('title'), el.getAttribute('aria-label')]);
    sources.push(link.textContent);
    for (const raw of sources) {
      if (!raw || /\d[\d.,]*\s*(k|m|b|bin|mn|milyon)(?:\s|$)/i.test(raw)) continue;
      const groups = raw.match(/\d[\d.,\s\u00a0]*\d|\d/g);
      if (groups?.length !== 1) continue;
      const value = groups[0].trim();
      if (!/^(?:\d+|\d{1,3}(?:[.,\s\u00a0]\d{3})+)$/.test(value)) continue;
      const number = Number(value.replace(/[.,\s\u00a0]/g, ''));
      if (Number.isSafeInteger(number)) return number;
    }
    fail('incomplete');
  }
  function dialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"],dialog[open]')].filter(visible);
    if (dialogs.length === 1) return dialogs[0];
  }
  function profileLinks(scope) {
    const suggestion = [...scope.querySelectorAll('h1,h2,h3,h4,span,div,[role="heading"]')].find(el =>
      ['suggested for you', 'senin için önerilenler', 'sana önerilenler', 'suggested'].includes(normalize(el.textContent)));
    return [...scope.querySelectorAll('a[href]')].filter(link => visible(link) && usernameFromLink(link) &&
      (!suggestion || Boolean(link.compareDocumentPosition(suggestion) & Node.DOCUMENT_POSITION_FOLLOWING)));
  }
  function profilePhoto(link, scope, username) {
    for (let row = link; row && row !== scope; row = row.parentElement) {
      if ([...row.querySelectorAll('a[href]')].some(anchor => {
        const name = usernameFromLink(anchor);
        return name && name !== username;
      })) return;
      const images = row.querySelectorAll('img[src]');
      if (images.length === 1) return images[0].currentSrc || images[0].src;
      if (images.length > 1) return;
    }
  }
  function scrollContainer(scope) {
    return [scope, ...scope.querySelectorAll('div,ul,[role="list"]')].filter(el =>
      el.scrollHeight > el.clientHeight + 3 && el.clientHeight > 0 &&
      /auto|scroll/.test(getComputedStyle(el).overflowY)).sort((a, b) =>
      profileLinks(b).length - profileLinks(a).length || a.clientHeight - b.clientHeight)[0];
  }
  async function waitFor(read, id, timeout = 30_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await send('relationships-check', {id});
      const result = read();
      if (result) return result;
      await sleep(1000);
    }
    fail('page');
  }
  async function scanList(username, kind, expected, id, photos) {
    if (expected === 0) return [];
    const link = listLink(username, kind);
    if (!link) fail('page');
    await send('relationships-check', {id});
    link.click();
    await waitFor(dialog, id);
    const seen = new Set();
    const started = Date.now();
    let lastGrowth = started;
    while (Date.now() - started < 2 * 60 * 60_000) {
      await send('relationships-check', {id});
      const scope = dialog();
      if (!scope) fail('page');
      const before = seen.size;
      for (const row of profileLinks(scope)) {
        const name = usernameFromLink(row);
        seen.add(name);
        if (!photos.has(name)) {
          const photo = profilePhoto(row, scope, name);
          if (photo) photos.set(name, photo);
        }
      }
      if (seen.size > expected) fail('counts_changed');
      await send('relationships-progress', {id, list: kind, seen: seen.size, total: expected});
      if (seen.size === expected) return [...seen];
      if (seen.size > before) lastGrowth = Date.now();
      const emptyNotice = normalize(scope.textContent).includes("you'll see all the people who follow you here.");
      if (kind === 'followers' && !seen.size && emptyNotice && Date.now() - started >= 6000) fail('unavailable');
      if (Date.now() - lastGrowth >= 60_000) fail('incomplete');
      const scroller = scrollContainer(scope);
      if (scroller) scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.8);
      await sleep(2500);
    }
    fail('incomplete');
  }
  async function closeDialog(id) {
    const scope = dialog();
    if (!scope) fail('page');
    const close = [...scope.querySelectorAll('button,[role="button"]')].find(el => {
      const label = normalize(el.getAttribute('aria-label') || el.textContent || el.querySelector('svg')?.getAttribute('aria-label'));
      return visible(el) && ['close', 'kapat'].includes(label);
    });
    if (close) {
      await send('relationships-check', {id});
      close.click();
    } else {
      const focused = document.activeElement;
      (focused && scope.contains(focused) ? focused : scope).dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true
      }));
    }
    await waitFor(() => !dialog(), id, 5000);
  }
  async function work(id) {
    try {
      const {username} = await send('relationships-check', {id});
      if (dialog()) await closeDialog(id);
      await waitFor(() => listLink(username, 'followers') && listLink(username, 'following'), id);
      if (!ownProfile(username)) fail('not_owner');
      const counts = {followers: exactCount(listLink(username, 'followers')),
        following: exactCount(listLink(username, 'following'))};
      await sleep(1500);
      await send('relationships-check', {id});
      if (counts.followers !== exactCount(listLink(username, 'followers')) ||
          counts.following !== exactCount(listLink(username, 'following'))) fail('counts_changed');
      const photos = new Map();
      const followers = await scanList(username, 'followers', counts.followers, id, photos);
      if (counts.followers) await closeDialog(id);
      const following = await scanList(username, 'following', counts.following, id, photos);
      if (counts.following) await closeDialog(id);
      await sleep(1500);
      await send('relationships-check', {id});
      if (!ownProfile(username)) fail('not_owner');
      if (counts.followers !== exactCount(listLink(username, 'followers')) ||
          counts.following !== exactCount(listLink(username, 'following'))) fail('counts_changed');
      await send('relationships-result', {id, counts, followers, following, photos: Object.fromEntries(photos), ownerConfirmed: true});
    } catch (error) {
      try { await send('relationships-error', {id, code: error.code || 'page'}); } catch {}
    }
  }

  function createView(panel, readArchive) {
    const view = document.createElement('section');
    view.innerHTML = `
      <p class="manual-hint">Takipçilerini ve takip ettiklerini kaydet. Sonraki kontrolde listeler karşılaştırılır.</p>
      <form data-relationship-form>
        <label>Instagram kullanıcı adın <input name="username" type="text" autocomplete="off" spellcheck="false" placeholder="@kullanici" required></label>
        <div class="queue-actions"><button type="submit" class="primary" data-relationship-start>İlk kaydı oluştur</button>
          <button type="button" class="stop" data-relationship-stop disabled>Durdur</button></div>
      </form>
      <details data-relationship-archive><summary>Instagram JSON arşivinden kayıt al</summary>
        <p class="manual-hint">Instagram arşivini JSON biçiminde, tüm zamanlar seçili ve takipçiler ile takip edilenler dahil olacak şekilde indir. Hazırlanma tarihi kaydın tarihi olarak kullanılır.</p>
        <form data-relationship-import>
          <label>Instagram ZIP dosyası <input type="file" name="archive" accept=".zip" required></label>
          <label>Arşivin hazırlanma tarihi <input type="datetime-local" name="archiveDate" required></label>
          <label><input type="checkbox" name="allTime" required> Bu arşiv kendi hesabıma ait. Tüm zamanları ve iki tam listeyi içeriyor.</label>
          <button class="secondary" type="submit">Arşivi kaydet ve karşılaştır</button>
          <p data-relationship-import-status class="manual-hint" role="status"></p>
        </form>
      </details>
      <p data-relationship-status role="status" class="manual-hint"></p>
      <p data-relationship-summary class="manual-hint"></p>
      <select data-relationship-filter aria-label="Değişiklikleri filtrele"><option value="all">Tüm değişiklikler</option>
        <option value="lost_follower">Takipçi listenden çıkanlar</option><option value="mutual">Biten takipleşmeler</option></select>
      <ul data-relationship-events aria-label="Takipleşme geçmişi"></ul>
      <button class="secondary" type="button" data-relationship-more hidden>Daha fazla göster</button>
      <details><summary>Kontrol tarihleri</summary><ul data-relationship-scans></ul></details>
      <p class="manual-hint">Tarihler iki kontrol arasındaki aralığı gösterir. Engelleme veya hesabın kapanması da listeden çıkmaya neden olabilir. İlk kayıt geçmiş günleri belirleyemez.</p>`;
    const style = document.createElement('style');
    style.textContent = `
      #studio-view-relationships form label{display:grid;gap:5px;color:#c5c5c5;font-size:12px}
      [data-relationship-import]{display:grid;gap:8px;margin-top:10px}
      #studio-view-relationships input[type=checkbox]{width:auto}
      #studio-view-relationships input{width:100%;padding:7px;background:#1e1e1e;color:#eee;border:1px solid #3b3b3b;border-radius:6px}
      [data-relationship-events],[data-relationship-scans]{list-style:none;margin:8px 0;padding:0;max-height:220px;overflow:auto;font-size:12px}
      [data-relationship-events] li,[data-relationship-scans] li{padding:8px 0;border-bottom:1px solid #303030;overflow-wrap:anywhere}
      [data-relationship-events] a{color:#eee;text-decoration:none;font-weight:650}
      [data-relationship-events] small{display:block;color:#aaa;margin-top:4px}
    `;
    panel.append(style);
    const find = selector => view.querySelector(selector);
    const form = find('form');
    const input = form.elements.username;
    const importForm = find('[data-relationship-import]');
    const status = find('[data-relationship-status]');
    const date = time => new Date(time).toLocaleString(locale());
    let revision = 0;
    let saved;
    let account;
    let visibleEvents = 200;
    const isOpen = () => !view.hidden && !panel.querySelector('[data-veil]').hidden;
    function renderEvents() {
      const filter = find('select').value;
      const events = (saved?.events || []).filter(event => filter === 'all' ||
        (filter === 'mutual' ? event.wasMutual : event.type === filter));
      const rows = events.slice(0, visibleEvents).map(event => {
        const row = document.createElement('li');
        const link = document.createElement('a');
        link.href = 'https://www.instagram.com/' + event.name + '/';
        link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '@' + event.name;
        const text = document.createElement('small');
        text.textContent = localize(event.type === 'lost_follower' ?
          (event.wasMutual ? 'Takipleşiyordunuz. Artık takipçi listende görünmüyor.' : 'Artık takipçi listende görünmüyor.') :
          'Takipleşiyordunuz. Artık takip ettiklerin listesinde görünmüyor.');
        const interval = document.createElement('small');
        interval.textContent = localize('Önceki kontrol ' + date(event.from) + ' · Değişimin görüldüğü kontrol ' + date(event.to));
        row.append(link, text, interval); return row;
      });
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.textContent = localize(saved ? 'Bu filtrede kaydedilmiş değişiklik yok.' : 'İlk kaydını oluştur. Bir sonraki kontrol değişiklikleri gösterecek.');
        rows.push(empty);
      }
      find('[data-relationship-events]').replaceChildren(...rows);
      find('[data-relationship-more]').hidden = events.length <= visibleEvents;
    }
    function renderJob(job) {
      find('[data-relationship-start]').disabled = Boolean(job?.running);
      input.disabled = Boolean(job?.running);
      for (const control of importForm.elements) control.disabled = Boolean(job?.running);
      find('[data-relationship-stop]').disabled = !job?.running;
      find('[data-relationship-start]').textContent = localize(saved ? 'Değişiklikleri kontrol et' : 'İlk kaydı oluştur');
      status.textContent = localize(job?.status || 'Hazır') + (job?.running && job.total != null ? ' ' + job.seen + ' / ' + job.total : '');
    }
    async function refresh() {
      const current = ++revision;
      if (!isOpen()) return;
      try {
        const response = await send('relationships-state');
        if (current !== revision || !isOpen()) return;
        saved = response.saved;
        const job = response.job;
        if (!input.value) input.value = saved?.username || guessUsername();
        account = response.account;
        renderJob(job);
        find('[data-relationship-summary]').textContent = saved ?
          localize((saved.latest.source === 'archive' ? 'Arşiv tarihi ' : 'Son kayıt ') + date(saved.latest.at)) +
          ' · ' + localize(saved.latest.followers + ' takipçi · ' + saved.latest.following + ' takip edilen') : '';
        renderEvents();
        find('[data-relationship-scans]').replaceChildren(...(saved?.scans || []).slice().reverse().map(scan => {
          const row = document.createElement('li');
          row.textContent = [date(scan.at), localize(scan.source === 'archive' ? 'Arşiv' : 'Canlı tarama'),
            localize(scan.followers + ' takipçi · ' + scan.following + ' takip edilen')].join(' · ');
          return row;
        }));
      } catch (error) { if (current === revision) status.textContent = localize(error.message); }
    }
    function guessUsername() {
      const current = location.pathname.match(/^\/([a-z0-9._]{1,30})\/?$/i)?.[1].toLowerCase();
      if (current && ownProfile(current)) return current;
      const ownLink = [...document.querySelectorAll('a[href]')].find(link => {
        if (link.closest('main,[role="main"]')) return false;
        const name = usernameFromLink(link);
        if (!name) return false;
        const label = normalize(link.getAttribute('aria-label') || link.textContent);
        const picture = normalize(link.querySelector('img')?.getAttribute('alt'));
        return ['profile', 'profil'].includes(label) || picture === name + "'s profile picture";
      });
      return ownLink ? usernameFromLink(ownLink) : '';
    }
    input.value = guessUsername();
    form.onsubmit = async event => {
      event.preventDefault();
      find('[data-relationship-start]').disabled = true;
      try { await send('relationships-start', {username: input.value.trim()}); await refresh(); }
      catch (error) { status.textContent = localize(error.message); find('[data-relationship-start]').disabled = false; }
    };
    importForm.onsubmit = async event => {
      event.preventDefault();
      const result = find('[data-relationship-import-status]');
      const file = importForm.elements.archive.files[0];
      const at = new Date(importForm.elements.archiveDate.value).getTime();
      const allTime = importForm.elements.allTime.checked;
      const username = input.value.trim();
      const expectedAccount = account;
      if (!file || !input.value.trim() || !allTime || !Number.isSafeInteger(at) || at > Date.now()) {
        result.textContent = localize('Kullanıcı adını, arşiv tarihini, ZIP dosyasını ve tüm zamanlar onayını kontrol et.');
        return;
      }
      for (const control of importForm.elements) control.disabled = true;
      find('[data-relationship-start]').disabled = true;
      input.disabled = true;
      result.textContent = localize('Arşiv yerel olarak okunuyor…');
      try {
        const lists = await readArchive(file);
        await send('relationships-import', {username, expectedAccount, at, allTime, ...lists});
        result.textContent = localize('Arşiv kaydedildi.');
        await refresh();
      } catch (error) { result.textContent = localize(error.message); }
      finally {
        for (const control of importForm.elements) control.disabled = false;
        find('[data-relationship-start]').disabled = false;
        input.disabled = false;
        await refresh();
      }
    };
    find('[data-relationship-stop]').onclick = async () => {
      try { await send('relationships-stop'); await refresh(); } catch (error) { status.textContent = localize(error.message); }
    };
    find('select').onchange = () => { visibleEvents = 200; renderEvents(); };
    find('[data-relationship-more]').onclick = () => { visibleEvents += 200; renderEvents(); };
    for (const target of [view, panel.querySelector('[data-veil]')]) {
      target.addEventListener(target === view ? 'studio-view-change' : 'studio-visibility', () => {
        if (isOpen()) void refresh();
        else { revision++; find('[data-relationship-events]').replaceChildren(); find('[data-relationship-scans]').replaceChildren(); saved = null; }
      });
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !isOpen()) return;
      const job = changes[jobKey]?.newValue;
      if (changes[stateKey] || (changes[jobKey] && (!job?.running || !account ||
          job.account?.id !== account.id || job.account?.storeId !== account.storeId))) void refresh();
      else if (job) renderJob(job);
    });
    return view;
  }
  return {work, createView};
})();
