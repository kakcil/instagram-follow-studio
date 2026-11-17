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
  const reactionTitles = new Set(['reactions', 'tepkiler', 'reaksiyonlar', 'ifadeler']);
  const reactionRemovalLabels = new Set(['select to remove', 'click to remove', 'kaldırmak için seç', 'kaldırmak için tıkla']);
  const closeLabels = new Set(['close', 'kapat']);
  const messageLabels = new Set(['message', 'mesaj', 'mesaj gönder', 'send message']);
  const expandChatLabels = new Set([
    'expand', 'expand chat', 'expand conversation', 'open in inbox', 'open in messages',
    'open chat in full screen', 'open in full screen', 'open in full view', 'open full conversation',
    'open in full chat', 'open in full page', 'view in inbox', 'open conversation',
    'büyüt', 'sohbeti büyüt', 'sohbeti genişlet', 'tam ekranda aç', 'sohbeti tam ekranda aç',
    'gelen kutusunda aç', 'mesajlarda aç', 'sohbeti aç'
  ]);
  const moreLabel = /^(see more options for message|more options|mesaj için daha fazla seçenek|daha fazla seçenek|altre opzioni|más opciones|plus d.options|weitere optionen|mais opções)(?:\b|\s|$)/iu;
  const restrictedText = /try again later|we (?:restrict|limit)|too many requests|action blocked|daha sonra tekrar dene|işlem engellendi|çok fazla istek/i;
  const thread = () => location.pathname.match(/^\/direct\/t\/(\d+)\/?$/)?.[1];
  let workerId;
  const delay = ms => document.hidden && workerId ? send('dm-delay', {id: workerId, ms}) :
    new Promise(resolve => setTimeout(resolve, ms));
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

  function requireAvailable() {
    if (/^\/(?:challenge|checkpoint|accounts\/login)(?:\/|$)/.test(location.pathname) ||
        [...document.querySelectorAll('[role="alert"], [role="dialog"], dialog[open]')]
          .some(element => visible(element) && restrictedText.test(element.textContent))) stop('restricted');
  }

  function requireThread(expected) {
    requireAvailable();
    if (thread() !== expected) stop('unsupported');
  }

  async function waitFor(read, expected, timeout = 5000, reason = 'unsupported') {
    const end = Date.now() + timeout;
    do {
      if (expected) requireThread(expected);
      else requireAvailable();
      const result = read();
      if (result) return result;
      await delay(150);
    } while (Date.now() < end);
    stop(reason);
  }

  function conversation() {
    const roots = [...document.querySelectorAll(messageLists)].filter(visible);
    return roots.length === 1 ? roots[0] : null;
  }

  function scrollContainer(root) {
    const candidates = [root, ...root.querySelectorAll('div')].filter(element =>
      element.clientHeight > 0 && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY));
    // The live message viewport is a reversed flex list. It can have no overflow
    // until Instagram hydrates the first page, or briefly after removing a row.
    return candidates.find(element => getComputedStyle(element).flexDirection === 'column-reverse' &&
      element.querySelector('[aria-roledescription="message"], [data-message-id], [role="row"]')) ||
      candidates.find(element => getComputedStyle(element).flexDirection === 'column-reverse') ||
      candidates.find(element => element.scrollHeight > element.clientHeight) || candidates[0] || root;
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

  function belongsToRecipient(row, username) {
    if (!username) return false;
    const labels = [...row.querySelectorAll('[aria-label]')].map(el => normalize(el.getAttribute('aria-label')));
    return labels.includes('see more options for message from ' + username) ||
      labels.includes('react to message from ' + username) ||
      [...row.querySelectorAll('a[href][aria-label]')].some(link => !link.closest('[aria-roledescription="message"]') &&
        /^(open the profile page of |.+ profil sayfasını aç$)/i.test(link.getAttribute('aria-label')) && profilePath(link) === username);
  }

  function reactionBadge(row) {
    const buttons = [...row.querySelectorAll('button, [role="button"]')].filter(button =>
      usable(button) && !button.closest('[aria-roledescription="message"]') &&
      !button.getAttribute('aria-label') && /\p{Extended_Pictographic}/u.test(button.textContent) &&
      /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(button.textContent));
    return buttons.length === 1 ? buttons[0] : null;
  }

  function reactionDialog() {
    const dialogs = visibleDialogs().filter(dialog =>
      [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')].some(heading =>
        visible(heading) && reactionTitles.has(normalize(heading.textContent))));
    return dialogs.length === 1 ? dialogs[0] : null;
  }

  function closeReactionDialog(dialog) {
    const close = labeledControl(dialog, closeLabels) ||
      [...dialog.querySelectorAll('button,[role="button"]')].find(button =>
        usable(button) && closeLabels.has(normalize(button.querySelector('svg[aria-label]')?.getAttribute('aria-label'))));
    if (!close) stop('reaction');
    close.click();
  }

  async function removeReaction(row, expected, check, id, preview) {
    await waitFor(() => !visiblePopovers().length, expected, 5000, 'overlay');
    const badge = reactionBadge(row);
    if (!badge) return false;
    await check();
    if (!row.contains(badge) || !usable(badge)) return false;
    badge.click();
    const dialog = await waitFor(reactionDialog, expected, 7000, 'reaction');
    const own = labeledControl(dialog, reactionRemovalLabels);
    if (!own || preview) {
      closeReactionDialog(dialog);
      await waitFor(() => !reactionDialog(), expected, 5000, 'reaction');
      return Boolean(own);
    }
    await check();
    await send('dm-commit', {id, operation: 'reaction'});
    requireThread(expected);
    if (!row.isConnected || reactionDialog() !== dialog || labeledControl(dialog, reactionRemovalLabels) !== own) stop('uncertain');
    own.click();
    await waitFor(() => row.isConnected && (!reactionDialog() ||
      !labeledControl(dialog, reactionRemovalLabels)), expected, 8000, 'uncertain');
    const remainingDialog = reactionDialog();
    if (remainingDialog) closeReactionDialog(remainingDialog);
    await waitFor(() => !reactionDialog(), expected, 5000, 'uncertain');
    await delay(650);
    if (!row.isConnected) stop('uncertain');
    const remainingBadge = reactionBadge(row);
    if (remainingBadge) {
      await check();
      remainingBadge.click();
      const review = await waitFor(reactionDialog, expected, 7000, 'uncertain');
      if (labeledControl(review, reactionRemovalLabels)) stop('uncertain');
      closeReactionDialog(review);
      await waitFor(() => !reactionDialog(), expected, 5000, 'uncertain');
    }
    await send('dm-removed', {id});
    return true;
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

  function profilePath(link) {
    const url = new URL(link.href, location.href);
    return url.origin === location.origin ? url.pathname.match(/^\/([a-z0-9._]+)\/?$/i)?.[1].toLowerCase() : null;
  }

  function directThreadPath(link) {
    const url = new URL(link.href, location.href);
    return url.origin === location.origin && /^\/direct\/t\/\d+\/?$/.test(url.pathname) ? url.pathname : null;
  }

  function chatSurfaces() {
    return [...document.querySelectorAll('[role="dialog"], dialog[open], [data-pagelet="IGDChatTab"], [data-pagelet="IGDChatTabContainer"]')]
      .filter(visible);
  }

  function expansionControls(root) {
    return [...root.querySelectorAll('button, [role="button"], a[href]')].filter(control => {
      if (!usable(control) || control.closest(messageLists)) return false;
      const labels = [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent,
        control.querySelector('svg[aria-label]')?.getAttribute('aria-label'), control.querySelector('svg title')?.textContent];
      return labels.some(label => expandChatLabels.has(normalize(label)));
    });
  }

  function chatExpansion(existingSurfaces, existingControls) {
    const fresh = chatSurfaces().filter(surface => !existingSurfaces.has(surface));
    const candidates = fresh.filter(surface => !fresh.some(other => other !== surface && surface.contains(other)));
    if (!candidates.length) {
      const controls = expansionControls(document).filter(control => {
        if (existingControls.has(control)) return false;
        for (let node = control.parentElement; node && node !== document.body; node = node.parentElement) {
          if (node.querySelector('[contenteditable="true"]') &&
              [...node.querySelectorAll('svg[aria-label]')].some(icon =>
                /^(close|kapat)$/i.test(icon.getAttribute('aria-label')))) return true;
        }
        return false;
      });
      return controls.length === 1 ? {control: controls[0]} : null;
    }
    if (candidates.length !== 1) return null;
    const popup = candidates[0];
    const header = popup.querySelector('header, [role="banner"], [data-pagelet="IGDThreadHeader"]');
    const scope = header || popup;
    const paths = new Set([...scope.querySelectorAll('a[href]')].filter(visible).map(directThreadPath).filter(Boolean));
    if (paths.size === 1) return {path: [...paths][0]};
    const controls = expansionControls(scope);
    return controls.length === 1 ? {control: controls[0]} : null;
  }

  function recipientMatches(username) {
    const list = conversation();
    if (!list) return false;
    // Only inspect conversation headers, never profile links inside messages.
    const scope = list.closest('main, [role="main"]');
    if (!scope) return false;
    const headers = [...scope.querySelectorAll('header, [role="banner"], [data-pagelet="IGDThreadHeader"]')]
      .filter(header => !header.contains(list) && !list.contains(header) && visible(header));
    const namedProfileLinks = [...scope.querySelectorAll('a[href][aria-label]')].filter(link => !list.contains(link) &&
      /^(open the profile page of |.+ profil sayfasını aç$)/i.test(link.getAttribute('aria-label')));
    const headerProfiles = new Set([...namedProfileLinks,
      ...headers.flatMap(header => [...header.querySelectorAll('a[href]')])]
      .filter(visible).map(profilePath).filter(Boolean));
    return headerProfiles.size === 1 && headerProfiles.has(username);
  }

  async function resolve(id, username) {
    workerId = id;
    let target;
    let preview;
    let options;
    try {
      if (!thread()) {
        const existingSurfaces = new Set(chatSurfaces());
        const existingControls = new Set(expansionControls(document));
        const message = await waitFor(() => {
          if (location.pathname.replace(/\/$/, '').toLowerCase() !== '/' + username) stop('recipient');
          const main = document.querySelector('main, [role="main"]');
          return main && labeledControl(main, messageLabels);
        }, null, 25000, 'recipient');
        message.click();
        const navigation = await waitFor(() => thread() ? {arrived: true} : chatExpansion(existingSurfaces, existingControls),
          null, 25000, 'popup');
        if (navigation.path) {
          location.assign(navigation.path);
          return;
        }
        if (navigation.control) navigation.control.click();
      }
      await waitFor(() => thread() && recipientMatches(username), null, 35000, 'recipient');
      ({thread: target, preview, options} = await send('dm-bind', {id, username}));
    } catch (error) {
      try { await send('dm-resolve-error', {id, reason: error.reason}); } catch {}
      return;
    }
    await work(id, target, preview, username, options);
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

  async function dismissMessageMenu(row, expected) {
    if (!visiblePopovers().length) return;
    const control = moreButton(row);
    const target = document.activeElement || control;
    const escape = {key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true};
    target?.dispatchEvent(new KeyboardEvent('keydown', escape));
    target?.dispatchEvent(new KeyboardEvent('keyup', escape));
    await waitFor(() => !visiblePopovers().length, expected, 2500, 'menu');
  }

  async function unsendRow(row, expected, check, id, preview) {
    await waitFor(() => !visiblePopovers().length, expected, 5000, 'overlay');
    hoverRow(row);
    const more = await waitFor(() => moreButton(row), expected, 5000, 'menu');
    await check();
    requireThread(expected);
    if (!row.contains(more) || !usable(more)) stop('menu');
    const {surface, item} = await openActions(more, expected);
    if (!row.isConnected || !usable(item) || !surface.contains(item)) stop('menu');
    if (preview) return;
    await send('dm-commit', {id, operation: 'message'});
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

  async function work(id, expected, preview = false, username, options = {messages: true}) {
    workerId = id;
    const check = async () => { requireThread(expected); await send('dm-check', {id}); };
    try {
      let root;
      let scroller;
      await waitFor(() => {
        root = conversation();
        if (!root) return false;
        scroller = scrollContainer(root);
        return messageRows(scroller).length ||
          /^(no messages yet|henüz mesaj yok)[.!]?$/i.test(normalize(root.textContent));
      }, expected, 45000, 'list');
      let stableTop = 0;
      let stalledTop = 0;
      let skipped = 0;
      let scrolled = false;
      let historyRetries = 0;
      const attempted = new WeakMap();
      const checkedReactions = new WeakMap();
      const eligible = item => withinViewport(item, scroller) && (
        (options.messages && outgoingRow(item) && !belongsToRecipient(item, username) && attempted.get(item) !== item.textContent) ||
        (options.reactions && belongsToRecipient(item, username) && checkedReactions.get(item) !== item.textContent && reactionBadge(item)));
      while (true) {
        await check();
        const currentRoot = await waitFor(conversation, expected, 35000, 'list');
        const currentScroller = scrollContainer(currentRoot);
        if (currentRoot !== root || currentScroller !== scroller) {
          root = currentRoot;
          scroller = currentScroller;
          stableTop = 0;
          stalledTop = 0;
        }
        const row = messageRows(scroller).reverse().find(eligible);
        if (row) {
          if (options.reactions && belongsToRecipient(row, username)) {
            checkedReactions.set(row, row.textContent);
            const verified = await removeReaction(row, expected, check, id, preview);
            checkedReactions.set(row, row.textContent);
            if (preview && verified) {
              await send('dm-finish', {id, reactionVerified: true});
              return;
            }
            stableTop = 0;
            stalledTop = 0;
            continue;
          }
          try {
            await unsendRow(row, expected, check, id, preview);
            if (preview) {
              await send('dm-finish', {id, menuVerified: true});
              return;
            }
          } catch (error) {
            if (error.reason !== 'menu') throw error;
            await dismissMessageMenu(row, expected);
            await delay(1000);
            if (row.isConnected) {
              try {
                await unsendRow(row, expected, check, id, preview);
                if (preview) {
                  await send('dm-finish', {id, menuVerified: true});
                  return;
                }
              } catch (retryError) {
                if (retryError.reason !== 'menu') throw retryError;
                await dismissMessageMenu(row, expected);
                attempted.set(row, row.textContent);
                skipped++;
              }
            }
          }
          stableTop = 0;
          stalledTop = 0;
          await delay(850);
          continue;
        }
        const before = scroller.scrollTop;
        const height = scroller.scrollHeight;
        const reverse = getComputedStyle(scroller).flexDirection === 'column-reverse';
        const oldest = reverse ? Math.min(0, scroller.clientHeight - height) : 0;
        const oldestRow = [...messageRows(scroller)].sort((a, b) =>
          a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        const oldestText = oldestRow?.textContent;
        const step = Math.max(100, Math.floor(scroller.clientHeight * 0.75));
        scroller.scrollTop = Math.max(oldest, before - step);
        await delay(1400);
        requireThread(expected);
        const loading = [...scroller.querySelectorAll('[role="progressbar"], [aria-busy="true"]')]
          .some(element => withinViewport(element, scroller));
        const unchanged = Math.abs(scroller.scrollTop - before) < 2 && scroller.scrollHeight === height;
        if (Math.abs(scroller.scrollTop - before) >= 2) scrolled = true;
        const atOldest = Math.abs(scroller.scrollTop - oldest) < 2;
        const samePage = !oldestRow || (oldestRow.isConnected && oldestRow.textContent === oldestText);
        stableTop = unchanged && atOldest && !loading && samePage ? stableTop + 1 : 0;
        stalledTop = unchanged && (loading || !atOldest) ? stalledTop + 1 : 0;
        if (!unchanged || !samePage) historyRetries = 0;
        if (stalledTop >= 12) {
          if (historyRetries >= 2) stop('history');
          historyRetries++;
          stalledTop = 0;
          // Re-enter the older-message loading boundary if Instagram stalled.
          scroller.scrollTop = before + step;
          await delay(850);
          scroller.scrollTop = Math.max(oldest, before - step);
          await delay(1400);
        }
        if (stableTop >= 6 && conversation() === root &&
            !messageRows(scroller).some(eligible)) break;
      }
      await send('dm-finish', {id, skipped, scrolled});
    } catch (error) {
      try { await send('dm-finish', {id, reason: error.reason || 'unsupported'}); } catch {}
    }
  }

  function createView(panel) {
    const view = document.createElement('section');
    view.innerHTML = `
      <p class="manual-hint">Gönderdiğin mesajlar arka planda geri alınır. Bu işlem geri döndürülemez.</p>
      <label>Instagram kullanıcı adı <input type="text" data-dm-username autocomplete="off" spellcheck="false" maxlength="31" placeholder="@kullanici"></label>
      <label class="manual-hint"><input type="checkbox" data-dm-reactions checked> Karşı tarafın mesajlarına verdiğim tepkileri kaldır.</label>
      <div class="queue-actions">
        <button type="button" class="primary" data-dm-start>Mesajları geri al</button>
        <button type="button" class="secondary" data-dm-reactions-only>Yalnızca tepkileri kaldır</button>
        <button type="button" class="secondary" data-dm-preview>Sohbeti kontrol et</button>
        <button type="button" class="secondary" data-dm-show>Çalışma penceresini göster</button>
        <button type="button" class="stop" data-dm-stop>Durdur</button>
      </div>
      <p class="manual-hint" data-dm-status role="status"></p>`;
    const find = selector => view.querySelector(selector);
    const reactions = find('[data-dm-reactions]');
    const username = find('[data-dm-username]');
    const start = find('[data-dm-start]');
    const reactionsOnly = find('[data-dm-reactions-only]');
    const preview = find('[data-dm-preview]');
    const show = find('[data-dm-show]');
    const stopButton = find('[data-dm-stop]');
    const status = find('[data-dm-status]');
    let revision = 0;
    let job;
    let pending = false;
    const isOpen = () => !view.hidden && !panel.querySelector('[data-veil]').hidden;

    function render() {
      username.disabled = pending || Boolean(job?.running);
      const unavailable = username.disabled || !/^@?[a-z0-9._]{1,30}$/i.test(username.value.trim());
      reactions.disabled = username.disabled;
      start.disabled = unavailable;
      start.textContent = localize(reactions.checked ? 'Mesajları geri al ve tepkileri kaldır' : 'Mesajları geri al');
      reactionsOnly.disabled = unavailable;
      reactionsOnly.hidden = !reactions.checked;
      preview.disabled = unavailable;
      show.hidden = !job?.canShow;
      stopButton.disabled = pending || !job?.running;
      const parts = [localize(job?.status || 'Hazır')];
      if (job?.username) parts.unshift('@' + job.username);
      if (job) parts.push(localize(job.count + ' mesaj geri alındı'));
      if (job?.reactions != null) parts.push(localize(job.reactions + ' tepki kaldırıldı'));
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
      let failure;
      pending = true;
      render();
      try {
        await send(type, data);
        await refresh();
      } catch (error) {
        failure = localize(error.message);
      } finally {
        pending = false;
        render();
        if (failure) status.textContent = failure;
      }
    }
    username.oninput = render;
    reactions.onchange = render;
    start.onclick = () => {
      if (start.disabled) return;
      return change('dm-start', {confirmed: true, removeReactions: reactions.checked, username: username.value.trim()});
    };
    reactionsOnly.onclick = () => {
      if (!reactionsOnly.disabled && reactions.checked) {
        return change('dm-start', {removeReactions: true, username: username.value.trim()});
      }
    };
    preview.onclick = () => {
      if (!preview.disabled) return change('dm-start', {preview: true, removeReactions: reactions.checked, username: username.value.trim()});
    };
    show.onclick = async () => {
      try { await send('dm-show'); } catch (error) { status.textContent = localize(error.message); }
    };
    stopButton.onclick = () => change('dm-stop');
    view.addEventListener('studio-view-change', () => { if (isOpen()) { render(); void refresh(); } });
    panel.querySelector('[data-veil]').addEventListener('studio-visibility', () => {
      if (isOpen()) { render(); void refresh(); } else revision++;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[queueKey] && isOpen()) void refresh();
    });
    render();
    return view;
  }

  return {createView, resolve, work};
})();
