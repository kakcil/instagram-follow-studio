'use strict';

globalThis.FollowStudioQueue = (() => {
  const {text: localize, locale} = FollowStudioI18n;
  const key = 'follow-studio-follow-queue';
  const settings = {min: 5, max: 5, batch: 5, rest: 30, limit: 10};
  const labels = {
    follow: ['follow', 'follow back', 'takip et', 'sen de takip et', 'geri takip et'],
    followed: ['following', 'takiptesin', 'takip ediliyor', 'takiptesiniz'],
    requested: ['requested', 'istek gönderildi', 'istek gönderildi̇', 'talep edildi', 'requested to follow', 'takip isteği gönderildi']
  };
  const status = {followed: 'Takip edildi', requested: 'İstek gönderildi', already: 'Zaten takip ediliyor'};
  const normalize = text => (text || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/i\u0307/g, 'i');
  async function send(type, data = {}) {
    const response = await chrome.runtime.sendMessage({type, ...data});
    if (!response?.ok) throw new Error(response?.error || 'Follow Studio bağlantısı kurulamadı.');
    return response;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const controls = 'button,[role="button"]';

  function actionLabel(el) {
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    const names = [labelledBy, el.getAttribute('aria-label'), el.innerText, el.textContent].map(normalize).filter(Boolean);
    const outcomes = Object.keys(labels).filter(key => names.some(name => labels[key].includes(name)));
    if (outcomes.length === 1) return outcomes[0];
  }

  function visible(el) {
    return el.getClientRects().length && !el.closest('[hidden],[aria-hidden="true"]');
  }

  function profileHeading(name) {
    const main = document.querySelector('main,[role="main"]');
    if (!main) return;
    const headings = [...main.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .filter(el => visible(el) && normalize(el.textContent) === name);
    if (headings.length === 1) return headings[0];
  }

  function profileHeader(name) {
    const heading = profileHeading(name);
    if (!heading) return;
    const main = heading.closest('main,[role="main"]');
    let scope = heading.parentElement;
    while (scope && scope !== main && main.contains(scope)) {
      if ([...scope.querySelectorAll(controls)].some(el => visible(el) && actionLabel(el))) return scope;
      scope = scope.parentElement;
    }
  }

  function profileAction(name) {
    const header = profileHeader(name);
    if (!header || document.querySelector('[role="dialog"], dialog[open]')) return;
    const actions = [...header.querySelectorAll(controls)].flatMap(el => {
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
          el.getAttribute('aria-busy') === 'true') return [];
      const outcome = actionLabel(el);
      return outcome ? [{el, outcome}] : [];
    });
    const distinct = actions.filter(action => !actions.some(other => other !== action && action.el.contains(other.el)));
    if (distinct.length === 1) return distinct[0];
  }

  function followError(code, message) {
    return Object.assign(new Error(message), {code});
  }

  function checkPage() {
    if (/^\/accounts\/login(?:\/|$)/.test(location.pathname)) throw followError('login_required', 'Instagram oturumu açılmalı.');
    if (/^\/(challenge|checkpoint)(?:\/|$)/.test(location.pathname)) throw followError('challenge_required', 'Instagram doğrulama istiyor.');
    const blocked = [...document.querySelectorAll('[role="alert"]')].some(el => visible(el) &&
      /try again later|we (restrict|limit)|too many requests|action blocked|daha sonra tekrar dene|işlem engellendi|çok fazla istek/i.test(el.textContent));
    if (blocked) throw followError('action_blocked', 'Instagram işlem kısıtlaması gösterdi.');
    if (document.querySelector('[role="dialog"],dialog[open]')) throw followError('dialog_blocked', 'Sayfada iletişim kutusu var.');
  }

  async function waitForAction(name, timeout = 25_000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      checkPage();
      const action = profileAction(name);
      if (action) return action;
      await sleep(250);
    }
    throw followError(document.querySelector('main,[role="main"]') ? 'button_missing' : 'page_unavailable', 'Profil düğmesi bulunamadı.');
  }

  async function settledAction(name) {
    // Instagram can update the button optimistically before rejecting a follow.
    await sleep(3000);
    const first = await waitForAction(name, 10_000);
    await sleep(500);
    checkPage();
    const second = profileAction(name);
    if (!second || first.outcome !== second.outcome) throw followError('state_unstable', 'Profil durumu henüz doğrulanamadı.');
    return second;
  }

  async function work(id) {
    let outcome = 'unverified';
    let code;
    let verificationRequested = false;
    try {
      checkPage();
      const job = await send('follow-check', {id});
      if (job.phase === 'verifying') {
        const action = await settledAction(job.name);
        if (!['followed', 'requested'].includes(action.outcome)) {
          throw followError('verification_failed', 'Sayfa yenilendikten sonra takip doğrulanamadı.');
        }
        await send('follow-result', {id, outcome: action.outcome});
        return;
      }
      let current = job;
      let action = current.attempts ? await settledAction(job.name) : await waitForAction(job.name);
      if (!current.attempts && action.outcome !== 'follow') action = await settledAction(job.name);
      const alreadyFollowing = !current.attempts && action.outcome === 'followed';
      while (action.outcome === 'follow' && (current.attempts || 0) < 2) {
        current = await send('follow-attempt', {id});
        checkPage();
        action = profileAction(job.name);
        if (action?.outcome !== 'follow') throw followError('state_unstable', 'Profil durumu değişti.');
        action.el.click();
        action = await settledAction(job.name);
      }
      outcome = alreadyFollowing ? 'already' : action.outcome;
      if (['followed', 'requested', 'already'].includes(outcome)) {
        verificationRequested = true;
        await send('follow-verify', {id, outcome});
        return;
      }
      code = 'rejected';
    } catch (error) {
      if (verificationRequested) return;
      code = error.code || 'connection_lost';
    }
    try { await send('follow-result', {id, outcome: 'unverified', code}); } catch {}
  }

  function attach(panel, refreshLists, readArchive) {
    const veil = panel.querySelector('[data-veil]');
    const gear = panel.querySelector('[data-open]');
    const body = panel.querySelector('.body');
    const legacy = document.createElement('section');
    legacy.className = 'studio-legacy';
    legacy.append(...body.childNodes);
    const legacyFooter = panel.querySelector('footer');
    legacyFooter.dataset.studioUnfollowFooter = '';
    const legacyOptions = document.createElement('details');
    legacyOptions.className = 'studio-unfollow-options';
    legacyOptions.innerHTML = '<summary>İşlem ayarları ve günlük</summary>';
    legacyOptions.append(...legacy.querySelectorAll('.settings, [data-estimate], .activity'));
    legacy.append(legacyOptions);

    const section = document.createElement('section');
    section.className = 'studio-queue';
    section.innerHTML = `
      <div class="queue-meta"><span data-follow-count></span><span data-follow-status role="status"></span></div>
      <ul aria-label="Takip kuyruğu" data-follow-list></ul>
      <div class="queue-actions">
        <button class="primary" type="submit" form="studio-follow-form">Başlat</button>
        <button class="stop" type="button" data-follow-stop>Durdur</button>
      </div>
      <details name="studio-follow-tools"><summary>Liste ekle ve taşı</summary>
        <form data-follow-add-list>
          <textarea rows="4" aria-label="Her satıra bir Instagram kullanıcı adı" placeholder="@kullanici1&#10;kullanici2" spellcheck="false" autocapitalize="none"></textarea>
          <div class="studio-transfer">
            <button class="secondary" type="button" data-follow-copy>Kalanları kopyala</button>
            <button class="secondary" type="button" data-follow-paste>Panodan yapıştır</button>
            <button class="secondary" type="submit">Listeyi kuyruğa ekle</button>
          </div>
          <p class="manual-hint">Her satıra bir kullanıcı adı yaz veya yapıştır. Kopyalama çalışmayı durdurur. Diğer bilgisayarda aynı Instagram hesabıyla devam et.</p>
          <p class="manual-hint" data-follow-import-result role="status"></p>
        </form>
      </details>
      <details name="studio-follow-tools"><summary>Zamanlama</summary>
        <form id="studio-follow-form">
          <label>En kısa aralık (dk) <input name="min" type="number" min="1" max="1440" required></label>
          <label>En uzun aralık (dk) <input name="max" type="number" min="1" max="1440" required></label>
          <label>Grup büyüklüğü <input name="batch" type="number" min="1" max="1440" required></label>
          <label>Ek grup molası (dk) <input name="rest" type="number" min="1" max="1440" required></label>
          <label>Oturum sınırı (profil) <input name="limit" type="number" min="1" max="50" required></label>
          <p class="manual-hint">Sınıra ulaşınca kalan liste korunur ve otomatik devam edilmez. Bu ayarlar kısıtlama yaşanmayacağını garanti etmez.</p>
        </form>
      </details>
      <details data-failed-section open hidden><summary>Doğrulanamayan profiller <span data-failed-count></span></summary>
        <ul aria-label="Doğrulanamayan profiller" data-follow-failed></ul>
      </details>
      <details name="studio-follow-tools" data-failure-log-section hidden><summary>Hata günlüğü</summary>
        <ul aria-label="Hata günlüğü" data-follow-errors></ul>
      </details>
      <details name="studio-follow-tools" data-history-section><summary>Takip geçmişi</summary>
        <ul aria-label="Takip geçmişi" data-follow-history></ul>
      </details>`;
    const tabs = document.createElement('div');
    tabs.className = 'studio-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', localize('Follow Studio araçları'));
    const relationshipView = FollowStudioRelationships.createView(panel, readArchive);
    const messagesView = FollowStudioMessages.createView(panel);
    const modules = [
      {id: 'follow', title: 'Toplu takip', view: section,
        icon: '<path d="M4 6h10m-10 6h7m-7 6h10m4-9v8m-4-4h8"/>'},
      {id: 'unfollow', title: 'Takipten çık', view: legacy,
        icon: '<circle cx="9" cy="7" r="3"/><path d="M3 19v-2a4 4 0 0 1 4-4h4m3 2h7"/>'},
      {id: 'relationships', title: 'Takipleşme', view: relationshipView,
        icon: '<path d="M3 12a9 9 0 1 0 3-6M3 3v6h6m3-2v5l3 2"/>'},
      {id: 'messages', title: 'Mesajlar', view: messagesView,
        icon: '<path d="M4 5h16v11H9l-5 3zM8 9h8m-8 3h6"/>'}
    ].map(module => {
      const {id, title, view, icon} = module;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = 'studio-tab-' + id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'studio-view-' + id);
      tab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + icon + '</svg>' + title;
      view.id = 'studio-view-' + id;
      view.dataset.studioView = id;
      view.setAttribute('role', 'tabpanel');
      view.setAttribute('aria-labelledby', tab.id);
      tabs.append(tab);
      return {...module, tab};
    });
    body.before(tabs);
    body.append(...modules.map(module => module.view));
    let activeModule;
    function selectModule(selected) {
      activeModule = selected;
      for (const module of modules) {
        const active = module === selected;
        module.tab.setAttribute('aria-selected', String(active));
        module.tab.tabIndex = active ? 0 : -1;
        module.view.hidden = !active;
      }
      legacyFooter.hidden = selected.view !== legacy;
      body.scrollTop = 0;
      if (veil.hidden) return;
      if (selected.view === section) {
        legacy.querySelector('[data-results]').replaceChildren();
        void refresh();
      } else {
        clearFollowRows();
        if (selected.view === legacy) refreshLists(false);
        else legacy.querySelector('[data-results]').replaceChildren();
      }
      relationshipView.dispatchEvent(new Event('studio-view-change'));
      messagesView.dispatchEvent(new Event('studio-view-change'));
    }
    modules.forEach((module, index) => {
      module.tab.onclick = () => selectModule(module);
      module.tab.onkeydown = event => {
        const offset = {ArrowLeft: -1, ArrowRight: 1}[event.key];
        if (!offset && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? modules.length - 1
          : (index + offset + modules.length) % modules.length;
        selectModule(modules[next]);
        modules[next].tab.focus();
      };
    });
    selectModule(modules[0]);

    const style = document.createElement('style');
    style.textContent = `
      :host{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#f5f5f5}
      :focus-visible{outline-color:#ededed!important}
      .veil{inset:auto 16px 61px auto;width:min(410px,calc(100vw - 32px));padding:0;
        display:block;background:none;backdrop-filter:none;animation:none}
      .dialog{width:100%;max-height:min(550px,calc(100dvh - 76px));border:1px solid #343434;border-radius:14px;
        background:#141414;box-shadow:0 12px 38px #0008;animation:none}
      .dialog header{padding:12px 14px;gap:8px}
      .dialog h1{font-size:16px;font-weight:670;letter-spacing:-.35px}
      .dialog .body{padding:0 14px 14px;scrollbar-color:#555 transparent}
      .dialog .close{width:28px;height:28px;line-height:1;border:0;background:transparent;color:#b6b6b6}
      .dialog .close:hover{background:#292929;color:#fff}
      .studio-tabs{display:flex;flex:none;overflow:auto;gap:14px;padding:0 14px;border-bottom:1px solid #303030}
      .studio-tabs button{display:flex;align-items:center;gap:7px;flex:none;padding:8px 3px 10px;border:0;
        border-bottom:2px solid transparent;background:transparent;color:#a8a8a8;font-size:12px;font-weight:600}
      .studio-tabs button:hover,.studio-tabs button[aria-selected=true]{color:#fafafa}
      .studio-tabs button[aria-selected=true]{border-bottom-color:#f5f5f5}
      .studio-tabs button:focus-visible{outline-offset:-3px}
      .studio-tabs svg,.studio-dock svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.6;
        stroke-linecap:round;stroke-linejoin:round;flex:none}
      .studio-dock{position:fixed;right:16px;bottom:16px;z-index:2147483645;display:flex;align-items:center}
      .studio-dock .launcher{position:relative;inset:auto;width:34px;height:34px;display:grid;place-items:center;
        padding:0;border:1px solid #414141;border-radius:10px;background:#181818;color:#f0f0f0;box-shadow:0 2px 8px #0004}
      .studio-dock .launcher:hover,.studio-dock .launcher[aria-expanded=true]{background:#303030}
      .studio-dock [data-follow-quick]{position:absolute;right:100%;left:auto;visibility:hidden}
      .studio-dock:hover [data-follow-quick],.studio-dock:focus-within [data-follow-quick],
      .studio-dock:has([aria-expanded=true]) [data-follow-quick]{visibility:visible}
      .studio-dock .launcher[data-queued]{color:#a8dec2;border-color:#4a6758;background:#202c26}
      .studio-dock .launcher[data-held]{color:#f2cf9d;border-color:#6a5941;background:#2b251d}
      .studio-dock .launcher::after{content:attr(aria-label);display:none;position:absolute;right:0;bottom:40px;
        white-space:nowrap;background:#202020;color:#fff;border:1px solid #414141;border-radius:6px;padding:4px 8px}
      .studio-dock .launcher:not([aria-expanded=true]):hover::after,.studio-dock .launcher:not([aria-expanded=true]):focus-visible::after{display:block}
      .studio-toast{position:absolute;right:0;bottom:40px;width:max-content;max-width:min(290px,calc(100vw - 32px));
        padding:7px 10px;background:#232323;border:1px solid #414141;border-radius:8px;font-size:12px}
      .queue-meta{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:12px 0 8px;color:#b5b5b5;font-size:12px}
      [data-follow-count]{font-weight:650;color:#f5f5f5;white-space:nowrap}
      [data-follow-status]{text-align:right}
      .studio-transfer{display:flex;gap:6px;flex-wrap:wrap}
      .queue-actions{display:flex;gap:6px;margin:10px 0 14px}
      .dialog .primary,.dialog .stop,.dialog .secondary{box-shadow:none;border-radius:7px}
      .dialog .primary{background:#ededed;border:1px solid #ededed;color:#161616;padding:6px 12px}
      .dialog .primary:hover{transform:none;background:#fff}
      .dialog .stop,.dialog .secondary{background:#252525;border:1px solid #3b3b3b;color:#ebebeb;padding:6px 10px}
      .studio-queue details{margin:0;padding:0;border-top:1px solid #303030}
      .studio-queue summary{padding:9px 0;color:#dedede;font-weight:550}
      .studio-queue form{margin:0 0 10px}
      .studio-queue textarea{margin:0 0 6px}
      .studio-queue [data-follow-import-result]:empty{display:none}
      #studio-follow-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      #studio-follow-form label{display:grid;gap:3px;font-size:11px;color:#b5b5b5}
      .dialog textarea,#studio-follow-form input,.dialog .seconds input,.dialog select{
        background:#1e1e1e;color:#eee;border:1px solid #3b3b3b;border-radius:6px}
      #studio-follow-form input{width:100%;padding:4px 6px}
      [data-follow-list],[data-follow-history],[data-follow-failed],[data-follow-errors]{max-height:150px;overflow:auto;list-style:none;margin:0;padding:0;font-size:12px}
      [data-follow-list]{border:1px solid #303030;border-radius:8px;background:#191919}
      [data-follow-list] li,[data-follow-history] li,[data-follow-failed] li,[data-follow-errors] li{padding:7px 9px;overflow-wrap:anywhere}
      [data-follow-list] li+li,[data-follow-history] li+li,[data-follow-failed] li+li,[data-follow-errors] li+li{border-top:1px solid #303030}
      [data-follow-list] li{display:flex;align-items:center;justify-content:space-between;gap:8px}
      [data-follow-list] .secondary{padding:2px 7px}
      .studio-legacy{padding-top:10px}
      [data-studio-unfollow-footer]{padding:8px 14px;flex-wrap:wrap;background:#141414}
      .studio-unfollow-options{margin-top:10px;padding-top:8px}
      .studio-legacy .stats{gap:5px;margin:0 0 10px}
      .studio-legacy .stat{padding:6px;border-radius:7px}
      .studio-legacy .stat strong{font-size:17px;color:#eee}
      .studio-legacy .stat small{font-size:9px;color:#adadad}
      .studio-legacy .upload{padding:9px;border-color:#626262;border-radius:7px;background:#202020}
      .studio-legacy .upload:hover,.studio-legacy .tabs button[aria-selected=true]{background:#303030;color:#fff}
      .studio-legacy .upload-icon,.studio-legacy .avatar,.studio-legacy .account a:hover{color:#e5e5e5}
      .studio-legacy .avatar,.studio-legacy .estimate,.studio-legacy .tabs{background:#222;border-color:#343434}
      .studio-legacy .account:hover{transform:none}
      .studio-legacy .row-action:hover{background:#303030;color:#fff}
      .studio-legacy :is(.file-caption,.note,.status,.estimate,.activity pre,summary,.tabs button,.settings label,.seconds,.manual-hint,.date){color:#b3b3b3}
      .studio-legacy .dot{background:#bcbcbc;box-shadow:none}
    `;
    panel.append(style);

    const dock = document.createElement('div');
    dock.className = 'studio-dock';
    const quick = document.createElement('button');
    quick.type = 'button';
    quick.className = 'launcher';
    quick.dataset.followQuick = '';
    quick.setAttribute('aria-label', localize('Takip kuyruğuna ekle'));
    const addIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 19v-2a4 4 0 0 1 4-4h4m6 0v6m-3-3h6"/></svg>';
    const queuedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 19v-2a4 4 0 0 1 4-4h4m3 3 2 2 5-5"/></svg>';
    const heldIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v5m0 3h.01"/></svg>';
    quick.innerHTML = addIcon;
    gear.setAttribute('aria-label', localize('Follow Studio araçları'));
    gear.setAttribute('aria-expanded', 'false');
    gear.setAttribute('aria-controls', 'studio-floating-panel');
    gear.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></svg>';
    veil.id = 'studio-floating-panel';
    const toast = document.createElement('output');
    toast.className = 'studio-toast';
    toast.hidden = true;
    dock.append(quick, gear, toast);
    panel.append(dock);
    FollowStudioI18n.markup(panel);

    const find = selector => section.querySelector(selector);
    const form = find('#studio-follow-form');
    const addList = find('[data-follow-add-list]');
    const feedback = find('[data-follow-status]');
    let timingState = {}, countdownTimer;
    function updateCountdown() {
      if (veil.hidden || section.hidden) return;
      const {status, running, next, job, count = 0, settings: saved = {}} = timingState;
      const remaining = Math.max(0, Math.ceil((next - Date.now()) / 1000));
      const parts = [localize(status || 'Hazır')];
      if (running) {
        parts.push(localize('Oturum ' + count + '/' + (saved.limit || settings.limit)));
        if (next && !job) parts.push(localize('Kalan ' + Math.floor(remaining / 60) + ' dk ' + remaining % 60 + ' sn'));
      }
      feedback.textContent = parts.join(' · ');
    }
    const history = find('[data-history-section]');
    const failedSection = find('[data-failed-section]');
    const failureLog = find('[data-failure-log-section]');
    let toastTimer;
    function showToast(text) {
      clearTimeout(toastTimer);
      toast.textContent = localize(text);
      toast.hidden = false;
      toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
    }

    async function action(type, data) {
      try { return await send(type, data); }
      catch (error) {
        if (veil.hidden) showToast(error.message);
        else feedback.textContent = localize(error.message);
      }
    }

    function render(state = {}) {
      timingState = state;
      if (veil.hidden || section.hidden) return;
      const {queue = [], failed = [], failures = [], history: entries = [], running, job, next} = state;
      find('[data-follow-count]').textContent = localize(queue.length + ' profil');
      find('[data-follow-stop]').disabled = !running;
      find('[type="submit"]').disabled = Boolean(running) || !queue.length;
      updateCountdown();
      const rows = queue.map(name => {
        const row = document.createElement('li');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.textContent = localize('Kaldır');
        remove.setAttribute('aria-label', localize('@' + name + ' profilini kaldır'));
        remove.disabled = job?.name === name;
        remove.onclick = () => action('follow-remove', {name});
        row.append('@' + name, remove);
        return row;
      });
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.textContent = localize(failed.length ? 'Kuyrukta kalan profil yok.' : 'Bir profil açıp kişi ekleme ikonuna bas.');
        rows.push(empty);
      }
      find('[data-follow-list]').replaceChildren(...rows);
      failedSection.hidden = !failed.length;
      find('[data-failed-count]').textContent = '(' + failed.length + ')';
      find('[data-follow-failed]').replaceChildren(...(failedSection.open ? failed.map(entry => {
        const row = document.createElement('li');
        const requeue = document.createElement('button');
        requeue.type = 'button';
        requeue.className = 'secondary';
        requeue.textContent = localize('Yeniden kuyruğa al');
        requeue.disabled = Boolean(running);
        requeue.onclick = () => action('follow-requeue', {name: entry.name});
        const parts = ['@' + entry.name, localize(entry.reason)];
        if (entry.skipped) parts.push(localize('Atlandı, sonraki profile geçildi'));
        if (entry.totalAttempts != null) parts.push(localize('Toplam ' + entry.totalAttempts + ' deneme'));
        if (entry.lastAttemptAt) parts.push(localize('Son deneme ' + new Date(entry.lastAttemptAt).toLocaleString(locale())));
        row.append(parts.join(' · ') + ' ', requeue);
        return row;
      }) : []));
      failureLog.hidden = !failures.length;
      find('[data-follow-errors]').replaceChildren(...(failureLog.open ? failures.map(entry => {
        const row = document.createElement('li');
        const parts = [localize(entry.reason), new Date(entry.time).toLocaleString(locale()),
          localize('Toplam ' + entry.totalAttempts + ' deneme')];
        if (entry.name) parts.unshift('@' + entry.name);
        row.textContent = parts.join(' · ');
        return row;
      }) : []));
      find('[data-follow-history]').replaceChildren(...(history.open ? entries.map(entry => {
        const row = document.createElement('li');
        const parts = ['@' + entry.name, localize(status[entry.outcome]), new Date(entry.time).toLocaleString(locale())];
        if (entry.totalAttempts != null) parts.push(localize('Toplam ' + entry.totalAttempts + ' deneme'));
        row.textContent = parts.join(' · ');
        return row;
      }) : []));
    }

    const currentName = () => location.pathname.match(/^\/([a-z0-9._]{1,30})\/?$/i)?.[1].toLowerCase();
    const reserved = new Set(['accounts', 'explore', 'direct', 'reels', 'stories', 'p', 'reel', 'about', 'challenge', 'developer']);
    let profileRevision = 0;
    let queued = false;
    let held = false;
    let updatingProfile = false;
    function renderProfile(state) {
      const name = currentName();
      quick.hidden = !name || reserved.has(name);
      queued = !quick.hidden && Boolean(state?.queue?.includes(name));
      held = !quick.hidden && Boolean(state?.failed?.some(entry => entry.name === name));
      quick.toggleAttribute('data-queued', queued);
      quick.toggleAttribute('data-held', held);
      quick.innerHTML = queued ? queuedIcon : held ? heldIcon : addIcon;
      quick.setAttribute('aria-label', localize(queued ? 'Kuyruğa eklendi · Kuyruktan kaldır' : held ? 'Takip doğrulanamadı · Listeyi aç' : 'Takip kuyruğuna ekle'));
    }
    async function refreshProfile() {
      const current = ++profileRevision;
      renderProfile();
      if (quick.hidden) return;
      try {
        const data = await chrome.storage.local.get(key);
        if (current === profileRevision) renderProfile(data[key]);
      } catch (error) { showToast(error.message); }
    }
    (window.navigation || window).addEventListener(window.navigation ? 'currententrychange' : 'popstate', refreshProfile);
    void refreshProfile();

    quick.onclick = async () => {
      if (updatingProfile) return;
      if (held) {
        failedSection.open = true;
        if (veil.hidden) gear.click();
        selectModule(modules[0]);
        return;
      }
      const name = currentName();
      if (!queued && !profileHeading(name)) {
        showToast('Profil yüklenince tekrar dene.');
        return;
      }
      const removing = queued;
      updatingProfile = true;
      try {
        const response = await action(removing ? 'follow-remove' : 'follow-add', removing ? {name} : undefined);
        if (response) showToast(removing ? '@' + name + ' kuyruktan kaldırıldı.' : response.status);
      } finally {
        updatingProfile = false;
      }
    };
    const transferInput = addList.querySelector('textarea');
    const transferStatus = addList.querySelector('[data-follow-import-result]');
    const copyList = addList.querySelector('[data-follow-copy]');
    const pasteList = addList.querySelector('[data-follow-paste]');
    copyList.onclick = async () => {
      copyList.disabled = true;
      try {
        const {text, count} = await send('follow-export');
        transferInput.value = text;
        if (!count) {
          transferStatus.textContent = localize('Kopyalanacak profil kalmadı.');
          return;
        }
        try {
          await navigator.clipboard.writeText(text);
          transferStatus.textContent = localize(count + ' profil kopyalandı. Diğer bilgisayarda yapıştırabilirsin.');
        } catch {
          transferInput.focus();
          transferInput.select();
          transferStatus.textContent = localize('Kalan liste seçildi. Kopyalamak için Ctrl+C kullan.');
        }
      } catch (error) {
        transferStatus.textContent = localize(error.message);
      } finally { copyList.disabled = false; }
    };
    pasteList.onclick = async () => {
      pasteList.disabled = true;
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) {
          transferStatus.textContent = localize('Pano boş.');
          return;
        }
        transferInput.value = text;
        transferInput.focus();
        transferStatus.textContent = localize('Liste yapıştırıldı. Eklemek için Listeyi kuyruğa ekle düğmesine bas.');
      } catch {
        transferInput.focus();
        transferStatus.textContent = localize('Bu alana Ctrl+V ile yapıştırıp Listeyi kuyruğa ekle düğmesine bas.');
      } finally { pasteList.disabled = false; }
    };
    addList.onsubmit = async event => {
      event.preventDefault();
      const input = addList.querySelector('textarea');
      const submit = addList.querySelector('[type="submit"]');
      const result = addList.querySelector('[data-follow-import-result]');
      const text = input.value;
      if (!text.trim()) {
        result.textContent = localize('Her satıra bir kullanıcı adı yaz.');
        return;
      }
      submit.disabled = true;
      try {
        const {counts} = await send('follow-add-list', {text});
        const summary = [counts.added + ' eklendi'];
        if (counts.duplicate) summary.push(counts.duplicate + ' tekrar atlandı');
        if (counts.completed) summary.push(counts.completed + ' daha önce tamamlandığı için atlandı');
        if (counts.held) summary.push(counts.held + ' doğrulanamayan profillerde');
        if (counts.invalid) summary.push(counts.invalid + ' geçersiz satır');
        result.textContent = summary.map(localize).join(' · ');
        if (!counts.invalid && input.value === text) input.value = '';
      } catch (error) {
        result.textContent = localize(error.message);
      } finally {
        submit.disabled = false;
      }
    };
    find('[data-follow-stop]').onclick = () => action('follow-stop');
    form.addEventListener('invalid', () => { form.closest('details').open = true; }, true);
    form.onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries(Object.keys(settings).map(name => [name, form.elements[name].valueAsNumber]));
      void action('follow-start', {settings: values});
    };

    let revision = 0;
    function clearFollowRows() {
      revision++;
      for (const selector of ['[data-follow-list]', '[data-follow-history]', '[data-follow-failed]', '[data-follow-errors]']) {
        find(selector).replaceChildren();
      }
    }
    async function refresh(loadSettings = false) {
      const current = ++revision;
      try {
        const data = await chrome.storage.local.get(key);
        if (current !== revision || veil.hidden) return;
        const state = data[key];
        if (loadSettings) {
          for (const name of Object.keys(settings)) form.elements[name].value =
            (state?.timingVersion ? state.settings?.[name] : undefined) ?? settings[name];
        }
        render(state);
      } catch (error) { feedback.textContent = localize(error.message); }
    }
    veil.addEventListener('studio-visibility', () => {
      clearInterval(countdownTimer);
      gear.setAttribute('aria-expanded', String(!veil.hidden));
      if (!veil.hidden) {
        countdownTimer = setInterval(updateCountdown, 1000);
        toast.hidden = true;
        for (const name of Object.keys(settings)) form.elements[name].value ||= settings[name];
        void refresh(true);
        if (activeModule.view === legacy) refreshLists(false);
      } else {
        clearFollowRows();
        legacy.querySelector('[data-results]').replaceChildren();
      }
    });
    for (const details of [history, failedSection, failureLog]) {
      details.addEventListener('toggle', () => { if (!veil.hidden) void refresh(); });
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[key]) return;
      profileRevision++;
      renderProfile(changes[key].newValue);
      if (!veil.hidden) render(changes[key].newValue);
    });
  }

  return {attach, work};
})();
