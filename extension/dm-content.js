'use strict';

globalThis.FollowStudioMessages = (() => {
  const {text: localize} = FollowStudioI18n;
  const queueKey = 'follow-studio-dm-queue';
  const messageLists = '[data-pagelet="IGDMessagesList"]';
  const controls = 'button, [role="button"], [role="menuitem"]';
  const unsendLabels = new Set([
    'unsend', 'unsend message', 'geri al', 'gönderimi geri al', 'gönderimi iptal et', 'mesajı geri al',
    'annulla invio', 'retirar', 'deshacer envío', 'retirer', 'zurücknehmen'
  ]);
  const cancelLabels = new Set(['cancel', 'iptal', 'vazgeç', 'annulla', 'cancelar', 'annuler', 'abbrechen']);
  const moreLabel = /^(see more options for message|more options|mesaj için daha fazla seçenek|daha fazla seçenek|altre opzioni|más opciones|plus d.options|weitere optionen|mais opções)(?:\b|\s|$)/iu;
  const restrictedText = /try again later|we (?:restrict|limit)|too many requests|action blocked|daha sonra tekrar dene|işlem engellendi|çok fazla istek/i;
  const thread = () => location.pathname.match(/^\/direct\/t\/(\d+)\/?$/)?.[1];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => (value || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/i\u0307/g, 'i');
  const visible = element => Boolean(element?.getClientRects().length && !element.closest('[hidden],[aria-hidden="true"]'));
  const usable = element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  const stop = reason => { throw Object.assign(new Error(reason), {reason}); };

  async function send(type, data = {}) {
    const result = await chrome.runtime.sendMessage({type, ...data});
    if (!result?.ok) throw new Error(result?.error || 'Mesaj kuyruğuna bağlanılamadı.');
    return result;
  }

  function visibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"], dialog[open]')].filter(visible);
  }

  function visiblePopovers() {
    return [...document.querySelectorAll('[role="menu"], [role="dialog"], dialog[open]')].filter(visible);
  }

  function requireThread(expected) {
    if (/^\/(?:challenge|checkpoint|accounts\/login)(?:\/|$)/.test(location.pathname) ||
        [...document.querySelectorAll('[role="alert"], [role="dialog"], dialog[open]')]
          .some(element => visible(element) && restrictedText.test(element.textContent))) stop('restricted');
    if (thread() !== expected) stop('unsupported');
  }

  async function waitFor(read, expected, timeout = 5000, reason = 'unsupported') {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      requireThread(expected);
      const result = read();
      if (result) return result;
      await delay(150);
    }
    stop(reason);
  }

  function conversation() {
    const roots = [...document.querySelectorAll(messageLists)].filter(visible);
    return roots.length === 1 ? roots[0] : null;
  }

  function scrollContainer(root) {
    const inner = [...root.querySelectorAll('div')].find(element => element.clientHeight > 0 &&
      /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight);
    return /^(auto|scroll)$/.test(getComputedStyle(root).overflowY) ? root : inner || root;
  }

  function messageRows(scroller) {
    const tagged = [...scroller.querySelectorAll('[data-message-id], [role="row"]')];
    if (tagged.length) return tagged.filter(row => !row.parentElement.closest('[data-message-id], [role="row"]'));
    // The supplied userscript identifies message rows beneath Instagram's message-list pagelet.
    const wrappers = [scroller, ...scroller.querySelectorAll(':scope > div, :scope > div > div, :scope > div > div > div')];
    const candidates = wrappers.map(wrapper => [...wrapper.children].filter(row =>
      row.matches('[role="none"], [role="presentation"]') || row.querySelector('[role="none"], [role="presentation"]')));
    return candidates.reduce((best, rows) => rows.length > best.length ? rows : best, []);
  }

  function outgoingRow(row) {
    const elements = [row, ...row.querySelectorAll('div, [role="group"]')];
    return elements.some(element => {
      const style = getComputedStyle(element);
      return style.justifyContent === 'flex-end' || style.alignSelf === 'flex-end';
    });
  }

  function withinViewport(row, scroller) {
    if (!visible(row)) return false;
    const bounds = row.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  }

  function moreButton(row) {
    return [...row.querySelectorAll('button, [role="button"]')].find(button => {
      if (!usable(button)) return false;
      const label = button.getAttribute('aria-label') ||
        button.querySelector('svg[aria-label]')?.getAttribute('aria-label') ||
        button.querySelector('svg title')?.textContent;
      return moreLabel.test(normalize(label));
    });
  }

  function hoverRow(row) {
    const targets = [row, ...row.querySelectorAll('[role="group"], [role="none"], [role="presentation"]')];
    for (const target of targets) {
      const bounds = target.getBoundingClientRect();
      const position = {bubbles: true, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2};
      if (typeof PointerEvent === 'function') {
        target.dispatchEvent(new PointerEvent('pointerenter', {...position, bubbles: false, pointerType: 'mouse'}));
        target.dispatchEvent(new PointerEvent('pointerover', {...position, pointerType: 'mouse'}));
        target.dispatchEvent(new PointerEvent('pointermove', {...position, pointerType: 'mouse'}));
      }
      target.dispatchEvent(new MouseEvent('mouseenter', {...position, bubbles: false}));
      target.dispatchEvent(new MouseEvent('mouseover', position));
    }
  }

  function labeledControl(root, labels) {
    const matches = new Set([...root.querySelectorAll(controls)].filter(element => usable(element) &&
      (labels.has(normalize(element.getAttribute('aria-label'))) || labels.has(normalize(element.textContent)))));
    // Instagram's dialog popover puts a short action label inside a button with extra text.
    for (const label of root.querySelectorAll('span, div')) {
      if (label.childElementCount || !visible(label) || !labels.has(normalize(label.textContent))) continue;
      const control = label.closest(controls);
      if (root.contains(control) && usable(control)) matches.add(control);
    }
    return matches.size === 1 ? [...matches][0] : null;
  }

  async function openActions(more, expected) {
    function findAction() {
      const surfaces = visiblePopovers();
      if (surfaces.length !== 1) return null;
      const surface = surfaces[0];
      const item = labeledControl(surface, unsendLabels);
      return item ? {surface, item} : null;
    }
    more.focus({preventScroll: true});
    more.click();
    try {
      return await waitFor(findAction, expected, 1000, 'menu');
    } catch (error) {
      if (error.reason !== 'menu') throw error;
      if (!visiblePopovers().length && usable(more)) {
        const enter = {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true};
        more.dispatchEvent(new KeyboardEvent('keydown', enter));
        more.dispatchEvent(new KeyboardEvent('keyup', enter));
      }
      return waitFor(findAction, expected, 5000, 'menu');
    }
  }

  async function unsendRow(row, expected, check, id) {
    if (visiblePopovers().length) stop('unsupported');
    hoverRow(row);
    const more = await waitFor(() => moreButton(row), expected, 5000, 'menu');
    await check();
    requireThread(expected);
    if (!row.contains(more) || !usable(more)) stop('menu');
    const {surface, item} = await openActions(more, expected);
    await send('dm-commit', {id});
    requireThread(expected);
    if (!row.isConnected || !usable(item) || visiblePopovers().length !== 1 || !visible(surface) ||
        !surface.contains(item)) stop('uncertain');
    item.click();

    const confirmation = await waitFor(() => {
      const dialogs = visibleDialogs();
      const matches = new Set(dialogs.filter(dialog => labeledControl(dialog, cancelLabels))
        .map(dialog => labeledControl(dialog, unsendLabels)).filter(button => button && button !== item));
      if (matches.size === 1) return [...matches][0];
      if (!visiblePopovers().length && !row.isConnected) return {completed: true};
    }, expected);
    if (!confirmation.completed) {
      await check();
      requireThread(expected);
      if (!usable(confirmation) || !visibleDialogs().some(dialog => dialog.contains(confirmation))) stop('uncertain');
      confirmation.click();
      await waitFor(() => !row.isConnected && !visiblePopovers().length, expected, 8000);
    }
    await delay(650);
    requireThread(expected);
    if (row.isConnected || visiblePopovers().length) stop('uncertain');
    await send('dm-removed', {id});
  }

  async function work(id, expected) {
    const check = async () => { requireThread(expected); await send('dm-check', {id}); };
    try {
      const root = await waitFor(conversation, expected, 25000);
      const scroller = scrollContainer(root);
      const emptyMessage = () => /^(no messages yet|henüz mesaj yok)[.!]?$/i.test(normalize(root.textContent));
      await waitFor(() => messageRows(scroller).length || emptyMessage(), expected, 10000);
      const reverse = getComputedStyle(scroller).flexDirection === 'column-reverse';
      scroller.scrollTop = reverse ? 0 : scroller.scrollHeight - scroller.clientHeight;
      let stableTop = 0;
      let stalledTop = 0;
      while (true) {
        await check();
        if (!scroller.isConnected || conversation() !== root) stop('unsupported');
        const row = messageRows(scroller).reverse().find(item => withinViewport(item, scroller) && outgoingRow(item));
        if (row) {
          await unsendRow(row, expected, check, id);
          stableTop = 0;
          stalledTop = 0;
          await delay(850);
          continue;
        }
        const before = scroller.scrollTop;
        const height = scroller.scrollHeight;
        const oldest = reverse ? Math.min(0, scroller.clientHeight - height) : 0;
        scroller.scrollTop = Math.max(oldest, before - Math.max(100, Math.floor(scroller.clientHeight * 0.75)));
        await delay(1400);
        requireThread(expected);
        const loading = [...root.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible);
        const unchanged = Math.abs(scroller.scrollTop - before) < 2 && scroller.scrollHeight === height;
        stableTop = unchanged && !loading ? stableTop + 1 : 0;
        stalledTop = unchanged && loading ? stalledTop + 1 : 0;
        if (stalledTop >= 8) stop('unsupported');
        if (stableTop >= 2) break;
      }
      await send('dm-finish', {id});
    } catch (error) {
      try { await send('dm-finish', {id, reason: error.reason || 'unsupported'}); } catch {}
    }
  }

  function createView(panel) {
    const view = document.createElement('section');
    view.innerHTML = `
      <p class="manual-hint" data-dm-context></p>
      <label class="manual-hint"><input type="checkbox" data-dm-confirm> Bu sohbette gönderdiğim mesajları herkes için geri al.</label>
      <div class="queue-actions">
        <button type="button" class="primary" data-dm-start>Mesajları geri al</button>
        <button type="button" class="stop" data-dm-stop>Durdur</button>
      </div>
      <p class="manual-hint" data-dm-status role="status"></p>`;
    const find = selector => view.querySelector(selector);
    const confirm = find('[data-dm-confirm]');
    const start = find('[data-dm-start]');
    const stopButton = find('[data-dm-stop]');
    const status = find('[data-dm-status]');
    let revision = 0;
    let currentThread;
    let job;
    let pending = false;
    const isOpen = () => !view.hidden && !panel.querySelector('[data-veil]').hidden;

    function render() {
      const active = thread();
      if (active !== currentThread) confirm.checked = false;
      currentThread = active;
      find('[data-dm-context]').textContent = localize(active ?
        'Gönderdiğin mesajlar bu sohbetten arka planda kaldırılır. Geri alınan mesajlar geri yüklenemez.' :
        'Mesajları geri almak için Instagram’da bir sohbet aç.');
      confirm.disabled = !active || pending || Boolean(job?.running);
      start.disabled = confirm.disabled || !confirm.checked;
      stopButton.disabled = pending || !job?.running;
      const parts = [localize(job?.status || 'Hazır')];
      if (job) parts.push(localize(job.count + ' mesaj geri alındı'));
      status.textContent = parts.join(' · ');
    }

    async function refresh() {
      const current = ++revision;
      try {
        const response = await send('dm-state');
        if (current !== revision || !isOpen()) return;
        job = response.job;
        render();
      } catch (error) {
        if (current === revision && isOpen()) status.textContent = localize(error.message);
      }
    }

    async function change(type, data) {
      if (pending) return;
      pending = true;
      confirm.checked = false;
      render();
      try {
        await send(type, data);
        await refresh();
      } catch (error) {
        status.textContent = localize(error.message);
      } finally {
        pending = false;
        confirm.disabled = !thread() || Boolean(job?.running);
        start.disabled = confirm.disabled || !confirm.checked;
        stopButton.disabled = !job?.running;
      }
    }
    confirm.onchange = render;
    start.onclick = () => {
      if (start.disabled || thread() !== currentThread) { render(); return; }
      return change('dm-start', {confirmed: true});
    };
    stopButton.onclick = () => change('dm-stop');
    view.addEventListener('studio-view-change', () => { if (isOpen()) { render(); void refresh(); } });
    panel.querySelector('[data-veil]').addEventListener('studio-visibility', () => {
      if (isOpen()) { render(); void refresh(); } else { revision++; confirm.checked = false; }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[queueKey] && isOpen()) void refresh();
    });
    render();
    return view;
  }

  return {createView, work};
})();
