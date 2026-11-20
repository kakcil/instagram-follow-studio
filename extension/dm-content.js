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
    const bubbles = [...scroller.querySelectorAll('[aria-roledescription="message"]')]
      .filter(bubble => !bubble.parentElement.closest('[aria-roledescription="message"]'));
    if (bubbles.length) {
      return bubbles.map(bubble => {
        let row = bubble;
        // Instagram inserts variable wrapper depths and reaction siblings.
        // Keep exactly one message in each row, including its action controls.
        while (row.parentElement && row.parentElement !== scroller &&
          row.parentElement.querySelectorAll('[aria-roledescription="message"]').length === 1) {
          row = row.parentElement;
        }
        return row;
      });
    }
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
    const senders = labels.filter(label => /^(see more options for message from |react to message from )/.test(label))
      .map(label => label.replace(/^(see more options for message from |react to message from )/, ''));
    if (senders.length) return senders.every(sender => sender === username);
    return (
      [...row.querySelectorAll('a[href][aria-label]')].some(link => !link.closest('[aria-roledescription="message"]') &&
        /^(open the profile page of |.+ profil sayfasını aç$)/i.test(link.getAttribute('aria-label')) && profilePath(link) === username));
  }

  function sentByCurrentAccount(row, username) {
    const senders = [...row.querySelectorAll('[aria-label]')]
      .map(el => normalize(el.getAttribute('aria-label')))
      .filter(label => label.startsWith('see more options for message from '))
      .map(label => label.slice('see more options for message from '.length));
    if (username && senders.length) return senders.every(sender => sender !== username);
    return outgoingRow(row) && !belongsToRecipient(row, username);
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

  async function removeReaction(row, scroller, expected, check, id, preview) {
    await waitFor(() => !visiblePopovers().length, expected, 5000, 'overlay');
    const badge = reactionBadge(row);
    if (!badge) return false;
    if (!await revealForAction(badge, scroller, expected)) return false;
    await check();
    if (!row.contains(badge) || !usable(badge)) return false;
    if (!actionFits(badge, scroller)) stop('message_edge');
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
      if (!await revealForAction(remainingBadge, scroller, expected)) stop('uncertain');
      await check();
      if (!row.contains(remainingBadge) || !actionFits(remainingBadge, scroller)) stop('uncertain');
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

  function actionViewport(scroller) {
    const bounds = scroller.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const bottom = Math.min(innerHeight, bounds.bottom);
    const inset = Math.min(12, Math.max(0, (bottom - top) / 4));
    return {top: top + inset, bottom: bottom - inset};
  }

  function actionFits(element, scroller) {
    if (!visible(element)) return false;
    const bounds = element.getBoundingClientRect();
    const viewport = actionViewport(scroller);
    const overlap = Math.min(bounds.bottom, viewport.bottom) - Math.max(bounds.top, viewport.top);
    return bounds.height > 0 && overlap >= Math.min(bounds.height, (viewport.bottom - viewport.top) / 2, 28) - 1 &&
      overlap > 0;
  }

  async function revealForAction(element, scroller, expected, recenter = false) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!scroller.contains(element)) return false;
      if (actionFits(element, scroller) && !recenter) return true;
      const bounds = element.getBoundingClientRect();
      const viewport = actionViewport(scroller);
      const delta = (bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2;
      // Moving toward older messages takes a negative scroll delta in both
      // ordinary and column-reverse lists.
      const before = scroller.scrollTop;
      if (Math.abs(delta) >= 2) scroller.scrollTop = before + delta;
      await delay(300);
      requireThread(expected);
      recenter = false;
    }
    if (!scroller.contains(element)) return false;
    if (!actionFits(element, scroller)) stop('message_edge');
    return true;
  }

  function historyPosition(scroller) {
    const viewport = scroller.getBoundingClientRect();
    const height = scroller.scrollHeight;
    const start = getComputedStyle(scroller).flexDirection === 'column-reverse' ?
      Math.min(0, scroller.clientHeight - height) : 0;
    const first = messageRows(scroller).filter(row => withinViewport(row, scroller))
      .reduce((oldest, row) => !oldest || row.getBoundingClientRect().top < oldest.getBoundingClientRect().top ? row : oldest, null);
    const loading = [...scroller.querySelectorAll('[role="progressbar"], [aria-busy="true"]')]
      .some(element => visible(element) && element.getBoundingClientRect().top < viewport.bottom);
    return {top: scroller.scrollTop, start, height, viewportHeight: viewport.height,
      first: first?.getAttribute('data-message-id') || first?.textContent, loading};
  }

  function historyChanged(before, after) {
    return Math.abs(before.top - after.top) >= 2 || before.height !== after.height || before.first !== after.first;
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

  function hoverRow(row, scroller) {
    const targets = [row, ...row.querySelectorAll('[role="group"], [role="none"], [role="presentation"]')];
    const viewport = actionViewport(scroller);
    for (const target of targets) {
      const bounds = target.getBoundingClientRect();
      const top = Math.max(bounds.top, viewport.top);
      const bottom = Math.min(bounds.bottom, viewport.bottom);
      if (bottom <= top) continue;
      const position = {bubbles: true, clientX: bounds.x + bounds.width / 2, clientY: (top + bottom) / 2};
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
        if (!/^\/direct\/inbox\/?$/.test(location.pathname)) stop('recipient');
        const compose = await waitFor(() => {
          const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(button => {
            if (!usable(button)) return false;
            return [button.getAttribute('aria-label'), button.textContent,
              button.querySelector('svg[aria-label]')?.getAttribute('aria-label')]
              .some(label => /^(new message|yeni mesaj)$/i.test(normalize(label)));
          });
          return buttons.length === 1 ? buttons[0] : null;
        }, null, 30000, 'search');
        compose.click();
        const dialog = await waitFor(() => {
          const dialogs = visibleDialogs().filter(dialog => dialog.querySelector('input[name="queryBox"]') ||
            [...dialog.querySelectorAll('input')].some(input => /^(search|ara)\.{0,3}$/i.test(input.placeholder)));
          return dialogs.length === 1 ? dialogs[0] : null;
        }, null, 15000, 'search');
        const selectedRecipients = () => [...dialog.querySelectorAll('button,[role="button"]')]
          .filter(button => usable(button) && [
            button.getAttribute('aria-label'),
            button.querySelector('svg[aria-label]')?.getAttribute('aria-label'),
            button.textContent
          ].some(label => /^(remove |kaldır )/i.test(normalize(label))));
        if (selectedRecipients().length || dialog.querySelector('input[type="checkbox"]:checked')) stop('recipient');
        const input = await waitFor(() => {
          const inputs = [...dialog.querySelectorAll('input')].filter(element => usable(element) &&
            (element.name === 'queryBox' || /^(search|ara)\.{0,3}$/i.test(element.placeholder)));
          return inputs.length === 1 ? inputs[0] : null;
        }, null, 30000, 'search');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setValue.call(input, username);
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
        await delay(1000);
        const result = await waitFor(() => {
          const matches = [...dialog.querySelectorAll('[role="option"]')].filter(element => {
            if (!usable(element) || element.closest(messageLists)) return false;
            return [element, ...element.querySelectorAll('span,div')].some(label =>
              !label.childElementCount && normalize(label.textContent).replace(/^@/, '') === username);
          });
          const rows = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));
          return rows.length === 1 ? rows[0] : null;
        }, null, 30000, 'search');
        const selection = result.querySelector('input[type="checkbox"]');
        if (!selection || selection.checked) stop('recipient');
        result.click();
        const chat = await waitFor(() => {
          const button = labeledControl(dialog, new Set(['chat', 'sohbet', 'sohbet et']));
          return selectedRecipients().length === 1 && button ? button : null;
        }, null, 10000, 'search');
        if (selectedRecipients().length !== 1) stop('recipient');
        chat.click();
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

  async function unsendRow(row, scroller, expected, check, id, preview, recenter = false) {
    await waitFor(() => !visiblePopovers().length, expected, 5000, 'overlay');
    if (!await revealForAction(row, scroller, expected, recenter)) return false;
    hoverRow(row, scroller);
    const more = await waitFor(() => moreButton(row), expected, 5000, 'menu');
    if (!await revealForAction(more, scroller, expected)) return false;
    await check();
    requireThread(expected);
    if (!row.contains(more) || !usable(more)) stop('menu');
    if (!actionFits(more, scroller)) stop('message_edge');
    const {surface, item} = await openActions(more, expected);
    if (!row.isConnected || !usable(item) || !surface.contains(item)) stop('menu');
    if (preview) return true;
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
    return true;
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
      // Instagram restores the last reading position, which may be in the
      // middle of the conversation. Always begin with the newest messages.
      scroller.scrollTop = getComputedStyle(scroller).flexDirection === 'column-reverse' ?
        0 : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      await delay(1400);
      let idleChecks = 0;
      let edgeRetries = 0;
      let retryFrom;
      let skipped = 0;
      let scrolled = false;
      const attempted = new WeakMap();
      const checkedReactions = new WeakMap();
      const eligible = item => withinViewport(item, scroller) && (
        (options.messages && sentByCurrentAccount(item, username) && attempted.get(item) !== item.textContent) ||
        (options.reactions && belongsToRecipient(item, username) && checkedReactions.get(item) !== item.textContent && reactionBadge(item)));
      while (true) {
        await check();
        const currentRoot = await waitFor(conversation, expected, 35000, 'list');
        const currentScroller = scrollContainer(currentRoot);
        if (currentRoot !== root || currentScroller !== scroller) {
          root = currentRoot;
          scroller = currentScroller;
          idleChecks = 0;
          edgeRetries = 0;
          retryFrom = undefined;
        }
        const row = messageRows(scroller).reverse().find(eligible);
        if (row) {
          if (options.reactions && belongsToRecipient(row, username)) {
            checkedReactions.set(row, row.textContent);
            const verified = await removeReaction(row, scroller, expected, check, id, preview);
            checkedReactions.set(row, row.textContent);
            if (preview && verified) {
              await send('dm-finish', {id, reactionVerified: true});
              return;
            }
            idleChecks = 0;
            edgeRetries = 0;
            retryFrom = undefined;
            continue;
          }
          try {
            const verified = await unsendRow(row, scroller, expected, check, id, preview);
            if (preview && verified) {
              await send('dm-finish', {id, menuVerified: true});
              return;
            }
          } catch (error) {
            if (error.reason !== 'menu') throw error;
            await dismissMessageMenu(row, expected);
            await delay(1000);
            if (row.isConnected) {
              try {
                const verified = await unsendRow(row, scroller, expected, check, id, preview, true);
                if (preview && verified) {
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
          idleChecks = 0;
          edgeRetries = 0;
          retryFrom = undefined;
          await delay(850);
          continue;
        }
        const before = historyPosition(scroller);
        const step = Math.max(1, Math.floor(scroller.clientHeight * 0.5));
        // Virtual lists may briefly render no rows after a scroll. Wait for
        // React to fill the viewport before moving past that part of the chat.
        const waitingForRows = before.first === undefined && before.height > scroller.clientHeight;
        if (!waitingForRows) scroller.scrollTop = Math.max(before.start, before.top - step);
        await delay(1400);
        requireThread(expected);
        if (conversation() !== root || !scroller.isConnected) continue;
        const after = historyPosition(scroller);
        if (Math.abs(after.top - before.top) >= 2) scrolled = true;
        const previousPosition = retryFrom || before;
        retryFrom = undefined;
        if (historyChanged(previousPosition, after)) {
          idleChecks = 0;
          edgeRetries = 0;
          continue;
        }
        if (++idleChecks < 6 || messageRows(scroller).some(eligible)) continue;
        const atStart = Math.abs(after.top - after.start) < 2;
        const canMove = scroller.scrollHeight - scroller.clientHeight >= 2 && scroller.clientHeight > 0;
        if (canMove && edgeRetries < 2) {
          // A write to the same scroll offset sends no scroll event. Leave
          // the loading boundary and let the next pass approach it again.
          edgeRetries++;
          idleChecks = 0;
          retryFrom = after;
          scroller.scrollTop = after.top + step;
          await delay(850);
          continue;
        }
        const empty = /^(no messages yet|henüz mesaj yok)[.!]?$/i.test(normalize(root.textContent));
        if (!atStart || after.loading || document.hidden || !after.viewportHeight ||
            (after.first === undefined && !empty)) stop('history');
        break;
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
