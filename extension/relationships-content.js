'use strict';

globalThis.FollowStudioRelationships = (() => {
  const {text: localize, locale} = FollowStudioI18n;
  const stateKey = 'follow-studio-relationships';
  const jobKey = 'follow-studio-relationship-job';
  const normalize = text => (text || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/i\u0307/g, 'i');
  const reserved = new Set(['accounts', 'explore', 'direct', 'reels', 'stories', 'p', 'reel', 'about', 'challenge']);
  const visible = el => el.getClientRects().length && !el.closest('[hidden],[aria-hidden="true"]');
  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({type, ...data});
    if (!response?.ok) throw new Error(response?.error || 'Tarama bağlantısı kurulamadı.');
    return response;
  }
  function usernameFromLink(link) {
    if (!link) return;
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
  function observePhotos(accepts, onPhotos) {
    const observed = new Map();
    const pending = new Map();
    let timer;

    function capture(image) {
      if (!image.complete || image.naturalWidth < 16 || image.naturalWidth !== image.naturalHeight ||
          !image.getClientRects().length || image.closest('[hidden]')) return;
      const alt = image.alt.match(/^([a-z0-9._]{1,30})(?:['’]s profile picture| profil (?:fotoğrafı|resmi))$/i);
      const altName = alt?.[1].toLowerCase();
      const linkName = usernameFromLink(image.closest('a[href]'));
      if (altName && linkName && altName !== linkName) return;
      const name = altName || linkName;
      const src = image.currentSrc || image.src;
      if (!name || !accepts(name) || !src || observed.get(name) === src) return;
      observed.set(name, src);
      pending.set(name, src);
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        onPhotos(Object.fromEntries(pending));
        pending.clear();
      }, 200);
    }

    document.addEventListener('load', event => {
      if (event.target instanceof HTMLImageElement) capture(event.target);
    }, true);
    return () => { for (const image of document.images) capture(image); };
  }

  function createView(panel, readArchive) {
    const view = document.createElement('section');
    view.innerHTML = `
      <p class="manual-hint">Takipçilerini ve takip ettiklerini kaydet. Sonraki kontrolde listeler karşılaştırılır.</p>
      <p class="manual-hint">Otomatik canlı tarama kapatıldı.</p>
      <details data-relationship-archive><summary>Instagram JSON arşivinden kayıt al</summary>
        <p class="manual-hint">Instagram arşivini JSON biçiminde, tüm zamanlar seçili ve takipçiler ile takip edilenler dahil olacak şekilde indir. Hazırlanma tarihi kaydın tarihi olarak kullanılır.</p>
        <form data-relationship-import>
          <label>Instagram kullanıcı adın <input name="username" type="text" autocomplete="off" spellcheck="false" placeholder="@kullanici" required></label>
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
    const importForm = find('[data-relationship-import]');
    const input = importForm.elements.username;
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
    async function refresh() {
      const current = ++revision;
      if (!isOpen()) return;
      try {
        const response = await send('relationships-state');
        if (current !== revision || !isOpen()) return;
        saved = response.saved;
        if (!input.value) input.value = saved?.username || guessUsername();
        account = response.account;
        status.textContent = localize(response.job?.status || 'Hazır');
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
      result.textContent = localize('Arşiv yerel olarak okunuyor…');
      try {
        const lists = await readArchive(file);
        await send('relationships-import', {username, expectedAccount, at, allTime, ...lists});
        result.textContent = localize('Arşiv kaydedildi.');
        await refresh();
      } catch (error) { result.textContent = localize(error.message); }
      finally {
        for (const control of importForm.elements) control.disabled = false;
        await refresh();
      }
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
      if (changes[stateKey] || changes[jobKey]) void refresh();
    });
    return view;
  }
  return {createView, observePhotos};
})();
