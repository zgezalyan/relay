const state = {
  globals: { variables: [] },
  environments: [],
  activeEnvironmentId: null,
  collections: [],
  history: [],
  draft: null,
  loaded: null,
  tabs: [],
  activeTabId: null,
};

const ui = {
  side: 'collections',
  reqTab: 'params',
  resTab: 'body',
  bodyView: 'pretty',
  search: '',
  collapsed: new Set(),
  editing: null,
  response: null,
  sending: false,
  inflightId: null,
  statusMessage: '',
  statusKind: '',
  persist: false,
  ready: false,
  bootError: '',
};

let flashTimer = 0;
let tabDrag = null;
let docTabsNeedRender = false;
let requestDrag = null;
let sideListNeedRender = false;

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  const props = attrs || {};
  if (tag === 'button' && !props.type) node.type = 'button';
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'checked') node.checked = true;
    else if (key === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) node.value = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function findCollection(id) {
  return state.collections.find((collection) => collection.id === id) || null;
}

function findRequest(collectionId, requestId) {
  const collection = findCollection(collectionId);
  if (!collection) return null;
  return walkItems(collection.items, (item) => (item.id === requestId ? item : null));
}

function walkItems(items, visit) {
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'folder') {
      const found = walkItems(item.items, visit);
      if (found) return found;
    } else {
      const found = visit(item);
      if (found) return found;
    }
  }
  return null;
}

function flatRequests(collection) {
  const requests = [];
  walkItems(collection?.items, (item) => {
    requests.push(item);
    return null;
  });
  return requests;
}

function countRequests(items) {
  let count = 0;
  for (const item of items || []) {
    if (item?.kind === 'folder') count += countRequests(item.items);
    else if (item) count += 1;
  }
  return count;
}

function findFolder(collection, folderId) {
  if (!collection || !folderId) return null;
  const stack = [...(collection.items || [])];
  while (stack.length) {
    const item = stack.pop();
    if (!item || item.kind !== 'folder') continue;
    if (item.id === folderId) return item;
    stack.push(...(item.items || []));
  }
  return null;
}

function parentList(collection, parentFolderId) {
  if (!collection) return null;
  if (!Array.isArray(collection.items)) collection.items = [];
  if (!parentFolderId) return collection.items;
  const folder = findFolder(collection, parentFolderId);
  if (!folder) return null;
  if (!Array.isArray(folder.items)) folder.items = [];
  return folder.items;
}

function locateRequest(collection, requestId) {
  function walk(items) {
    for (let index = 0; index < (items || []).length; index += 1) {
      const item = items[index];
      if (item?.kind === 'folder') {
        const nested = walk(item.items);
        if (nested) return nested;
      } else if (item?.id === requestId) return { items, index, item };
    }
    return null;
  }
  return walk(collection?.items);
}

function folderPath(collection, requestId) {
  function walk(items, trail) {
    for (const item of items || []) {
      if (item?.kind === 'folder') {
        const found = walk(item.items, [...trail, item.name]);
        if (found) return found;
      } else if (item?.id === requestId) return trail;
    }
    return null;
  }
  return walk(collection?.items, []) || [];
}

function folderChoices(collection) {
  const options = [{ id: '', label: 'Collection root' }];
  function walk(items, prefix) {
    for (const item of items || []) {
      if (item?.kind !== 'folder') continue;
      const label = prefix ? `${prefix} / ${item.name}` : item.name;
      options.push({ id: item.id, label });
      walk(item.items, label);
    }
  }
  walk(collection?.items, '');
  return options;
}

function folderIdOfRequest(collection, requestId) {
  function walk(items, parentId) {
    for (const item of items || []) {
      if (item?.kind === 'folder') {
        const found = walk(item.items, item.id);
        if (found != null) return found;
      } else if (item?.id === requestId) return parentId;
    }
    return null;
  }
  const found = walk(collection?.items, '');
  return found == null ? '' : found;
}

function cloneItems(items) {
  return (items || []).map((item) => {
    if (item?.kind === 'folder') {
      return { kind: 'folder', id: RelayCore.newId(), name: item.name, items: cloneItems(item.items) };
    }
    return { id: RelayCore.newId(), ...withFreshRowIds(RelayCore.normalizeRequest(item)) };
  });
}

function folderGlyph() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M1.8 4.2h4.1l1.3 1.4H14.2V12.6H1.8V4.2z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function findEnvironment(id) {
  return state.environments.find((env) => env.id === id) || null;
}

function activeEnvironment() {
  return findEnvironment(state.activeEnvironmentId);
}

function currentScope() {
  return RelayCore.buildScope(state.globals, activeEnvironment());
}

function currentBuilt() {
  if (!state.draft) return null;
  return RelayCore.buildOutgoing(state.draft, currentScope());
}

function signatureOf(draft) {
  return JSON.stringify(RelayCore.normalizeRequest(draft));
}

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function activeRequestTab() {
  const tab = activeTab();
  return tab && tab.kind === 'request' ? tab : null;
}

function isDirty() {
  const tab = activeRequestTab();
  if (!tab) return false;
  return signatureOf(tab.draft) !== tab.savedSignature;
}

function requestHasContent(draft) {
  return signatureOf(draft) !== signatureOf(RelayCore.createEmptyDraft());
}

function makeRequestTab(draft, loaded) {
  const hydrated = RelayCore.hydrateDraft(draft || RelayCore.createEmptyDraft());
  const link = loaded?.collectionId && loaded?.requestId
    ? { collectionId: loaded.collectionId, requestId: loaded.requestId }
    : null;
  let savedSignature = signatureOf(hydrated);
  if (link) {
    const saved = findRequest(link.collectionId, link.requestId);
    if (saved) savedSignature = signatureOf(saved);
  }
  return {
    id: RelayCore.newId(),
    kind: 'request',
    draft: hydrated,
    loaded: link,
    response: null,
    savedSignature,
    reqTab: 'params',
    sending: false,
    inflightId: null,
    sendGeneration: 0,
    historyId: null,
  };
}

function captureRequestTab() {
  const tab = activeRequestTab();
  if (!tab) return;
  tab.reqTab = ui.reqTab;
  tab.response = ui.response;
  tab.loaded = state.loaded;
}

function showRequestTab(tab) {
  if (!tab || tab.kind !== 'request') return;
  state.draft = tab.draft;
  state.loaded = tab.loaded;
  ui.response = tab.response || null;
  ui.reqTab = tab.reqTab || 'params';
}

function mirrorSending() {
  const tab = activeRequestTab();
  ui.sending = Boolean(tab?.sending);
  ui.inflightId = tab?.inflightId || null;
  if (document.getElementById('send-btn')) paintSendButton();
}

function focusLater(id, select) {
  requestAnimationFrame(() => {
    const field = document.getElementById(id);
    if (!field || field.closest('[hidden]')) return;
    field.focus();
    if (select) field.select();
  });
}

function listByName(name) {
  if (name === 'params') return state.draft.params;
  if (name === 'headers') return state.draft.headers;
  if (name === 'urlencoded') return state.draft.urlencoded;
  return state.draft.formdata;
}

function varList(scope, envId) {
  if (scope === 'globals') return state.globals.variables;
  return findEnvironment(envId)?.variables || [];
}

function serializeItems(items) {
  return (items || []).map((item) => {
    if (item?.kind === 'folder') {
      return { kind: 'folder', id: item.id, name: item.name, items: serializeItems(item.items) };
    }
    return { id: item.id, ...RelayCore.normalizeRequest(item) };
  });
}

function serializeTab(tab) {
  if (tab.kind === 'environment') return { id: tab.id, kind: 'environment', envId: tab.envId };
  return {
    id: tab.id,
    kind: 'request',
    draft: RelayCore.normalizeRequest(tab.draft),
    loaded: tab.loaded,
    reqTab: tab.reqTab || 'params',
    historyId: tab.historyId || null,
  };
}

function workspacePayload() {
  const active = activeRequestTab();
  if (active) active.reqTab = ui.reqTab;
  const current = active || state.tabs.find((tab) => tab.kind === 'request') || null;
  return {
    version: 1,
    globals: { variables: RelayCore.stripVars(state.globals.variables) },
    environments: state.environments.map((env) => ({
      id: env.id,
      name: env.name,
      variables: RelayCore.stripVars(env.variables),
    })),
    activeEnvironmentId: state.activeEnvironmentId,
    collections: state.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      items: serializeItems(collection.items),
    })),
    history: state.history.slice(0, 50),
    draft: RelayCore.normalizeRequest(current ? current.draft : RelayCore.createEmptyDraft()),
    loaded: current ? current.loaded : null,
    tabs: state.tabs.map(serializeTab),
    activeTabId: state.activeTabId,
  };
}

function scheduleSave() {
  if (!ui.persist) return;
  clearTimeout(scheduleSave.timer);
  scheduleSave.timer = setTimeout(() => persistNow(), 400);
}

async function persistNow() {
  if (!ui.persist) return;
  const result = await window.relay.save(workspacePayload());
  if (!result?.ok) flash(result?.error || 'Could not save the workspace.', 'error');
}

function flash(message, kind) {
  ui.statusMessage = message;
  ui.statusKind = kind || 'ok';
  renderStatus();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    ui.statusMessage = '';
    renderStatus();
  }, 3600);
}

function statusClass(status) {
  if (!status) return 's0';
  if (status < 300) return 's2';
  if (status < 400) return 's3';
  if (status < 500) return 's4';
  return 's5';
}

function formatMs(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function fileLabel(filePath) {
  const value = String(filePath || '');
  if (!value) return 'No file chosen';
  const parts = value.split(/[/\\]/);
  return parts[parts.length - 1] || value;
}

function matches(query, ...parts) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.some((part) => String(part || '').toLowerCase().includes(needle));
}

function withFreshRowIds(request) {
  for (const key of ['params', 'headers', 'urlencoded', 'formdata']) {
    request[key] = (request[key] || []).map((row) => ({ ...row, id: RelayCore.newId() }));
  }
  return request;
}

function applyWorkspace(workspace) {
  const clean = RelayCore.sanitizeWorkspace(workspace);
  state.globals = { variables: clean.globals.variables };
  state.environments = clean.environments;
  state.activeEnvironmentId = clean.activeEnvironmentId;
  state.collections = clean.collections;
  state.history = clean.history;
  RelayCore.ensureVarTrailing(state.globals.variables);
  for (const env of state.environments) RelayCore.ensureVarTrailing(env.variables);
  state.tabs = (clean.tabs || []).map((tab) => {
    if (tab.kind === 'environment') return { id: tab.id, kind: 'environment', envId: tab.envId };
    const draft = RelayCore.hydrateDraft(tab.draft);
    const loaded = tab.loaded && findRequest(tab.loaded.collectionId, tab.loaded.requestId) ? tab.loaded : null;
    let savedSignature = signatureOf(draft);
    if (loaded) {
      const saved = findRequest(loaded.collectionId, loaded.requestId);
      if (saved) savedSignature = signatureOf(saved);
    }
    return {
      id: tab.id,
      kind: 'request',
      draft,
      loaded,
      response: null,
      savedSignature,
      reqTab: tab.reqTab || 'params',
      sending: false,
      inflightId: null,
      sendGeneration: 0,
      historyId: tab.historyId || null,
    };
  });
  state.activeTabId = state.tabs.some((tab) => tab.id === clean.activeTabId) ? clean.activeTabId : (state.tabs[0]?.id || null);
  const active = activeRequestTab() || state.tabs.find((tab) => tab.kind === 'request');
  if (active) {
    state.draft = active.draft;
    state.loaded = active.loaded;
    ui.response = null;
    ui.reqTab = active.reqTab || 'params';
  } else {
    state.draft = RelayCore.hydrateDraft(clean.draft || RelayCore.createEmptyDraft());
    state.loaded = null;
    ui.response = null;
    ui.reqTab = 'params';
  }
  ui.sending = false;
  ui.inflightId = null;
}

function refreshDerived() {
  if (!state.draft) {
    renderStatus();
    scheduleSave();
    return;
  }
  const built = currentBuilt();
  updateResolved(built);
  updateGenerated(built);
  updateCurlPreview(built);
  updateCounts();
  paintCrumb();
  paintSave();
  renderDocTabs();
  renderStatus();
  scheduleSave();
}

function paintMethod() {
  document.getElementById('method').dataset.method = state.draft.method;
}

function paintTabs() {
  document.querySelectorAll('#req-tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === ui.reqTab);
  });
}

function paintResTabs() {
  document.querySelectorAll('#res-tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.res === ui.resTab);
  });
}

function paintSave() {
  const button = document.getElementById('save-btn');
  const dirty = isDirty();
  button.textContent = dirty ? 'Save*' : 'Save';
  button.classList.toggle('is-dirty', dirty);
}

function paintCrumb() {
  const crumb = document.getElementById('crumb');
  if (!state.loaded) {
    crumb.textContent = 'Unsaved request';
    return;
  }
  const collection = findCollection(state.loaded.collectionId);
  const path = collection
    ? [collection.name, ...folderPath(collection, state.loaded.requestId), state.draft.name || 'Untitled request']
    : [state.draft.name || 'Untitled request'];
  crumb.textContent = path.join('  /  ');
}

function paintSendButton() {
  const button = document.getElementById('send-btn');
  button.textContent = ui.sending ? 'Cancel' : 'Send';
  button.classList.toggle('is-cancel', ui.sending);
  button.title = ui.sending ? 'Cancel the request' : 'Send (Ctrl+Enter)';
}

function renderStatus() {
  const bar = document.querySelector('.statusbar');
  const left = document.getElementById('status-left');
  const right = document.getElementById('status-right');
  bar.classList.toggle('is-error', ui.statusKind === 'error' && Boolean(ui.statusMessage));
  bar.classList.toggle('is-ok', ui.statusKind !== 'error' && Boolean(ui.statusMessage));
  if (ui.statusMessage) left.textContent = ui.statusMessage;
  else left.textContent = isDirty() ? 'Unsaved changes' : 'Saved locally';
  const env = activeEnvironment();
  right.textContent = `${env ? `Globals + ${env.name}` : 'Globals only'}   ·   Ctrl+Enter sends   ·   Ctrl+S saves`;
}

function updateCounts() {
  const count = (rows) => rows.filter((row) => row.enabled !== false && String(row.key || '').trim()).length;
  const set = (id, label, amount) => {
    document.getElementById(id).textContent = amount ? `${label} (${amount})` : label;
  };
  set('tab-params', 'Params', count(state.draft.params));
  set('tab-headers', 'Headers', count(state.draft.headers));
  set('tab-body', 'Body', state.draft.bodyMode === 'none' ? 0 : 1);
  set('tab-auth', 'Auth', state.draft.authType === 'none' ? 0 : 1);
  const response = ui.response;
  const headerCount = response?.headers?.length || 0;
  document.getElementById('res-headers').textContent = headerCount ? `Headers (${headerCount})` : 'Headers';
}

function updateResolved(built = currentBuilt()) {
  const line = document.getElementById('resolved');
  if (!state.draft.url.trim()) {
    line.textContent = '';
    line.className = 'resolved-line';
    return;
  }
  if (built.missing.length) {
    line.textContent = `→  ${built.request.url}    Unresolved: ${built.missing.join(', ')}`;
    line.className = 'resolved-line is-warn';
    return;
  }
  if (built.error) {
    line.textContent = built.error;
    line.className = 'resolved-line is-error';
    return;
  }
  line.textContent = `→  ${built.request.url}`;
  line.className = 'resolved-line';
}

function updateGenerated(built = currentBuilt()) {
  const host = document.getElementById('generated-headers');
  if (!host) return;
  host.replaceChildren();
  if (built.error) host.append(el('p', { class: 'hint is-warn', text: built.error }));
  for (const header of built.request?.headers || []) {
    host.append(el('div', { class: 'gen-row', text: `${header.key}: ${header.value}` }));
  }
  for (const warning of built.warnings || []) host.append(el('p', { class: 'hint is-warn', text: warning }));
}

function refreshEnvSelect() {
  const select = document.getElementById('env-select');
  const current = state.activeEnvironmentId || '';
  select.replaceChildren(new Option('No environment', ''));
  for (const env of state.environments) select.append(new Option(env.name, env.id));
  select.value = state.environments.some((env) => env.id === current) ? current : '';
  state.activeEnvironmentId = select.value || null;
}

function paintSideSwitch() {
  document.querySelectorAll('[data-side]').forEach((button) => {
    button.classList.toggle('active', button.dataset.side === ui.side);
  });
  const primary = document.getElementById('side-primary');
  const secondary = document.getElementById('side-secondary');
  const search = document.getElementById('side-search');
  if (ui.side === 'collections') {
    primary.hidden = false;
    primary.textContent = 'New collection';
    secondary.hidden = false;
    secondary.textContent = 'New request';
    search.placeholder = 'Search collections';
  } else if (ui.side === 'environments') {
    primary.hidden = false;
    primary.textContent = 'New environment';
    secondary.hidden = true;
    search.placeholder = 'Search environments';
  } else {
    primary.hidden = false;
    primary.textContent = 'Clear history';
    secondary.hidden = true;
    search.placeholder = 'Search history';
  }
}

function focusEditing() {
  requestAnimationFrame(() => {
    const field = document.querySelector('[data-autofocus]');
    if (!field) return;
    field.focus();
    field.select();
  });
}

function renderAll() {
  refreshEnvSelect();
  paintSideSwitch();
  renderSidebarList();
  renderDocTabs();
  showDocument();
  const tab = activeTab();
  if (!tab) {
    renderStatus();
    return;
  }
  if (tab.kind === 'environment') {
    renderEnvPane();
    refreshDerived();
    return;
  }
  renderEditor();
}

function showDocument() {
  const kind = activeTab()?.kind || 'empty';
  document.getElementById('request-pane').hidden = kind !== 'request';
  document.getElementById('splitter').hidden = kind !== 'request';
  document.getElementById('response-pane').hidden = kind !== 'request';
  document.getElementById('env-pane').hidden = kind !== 'environment';
  document.getElementById('doc-empty').hidden = kind !== 'empty';
}

function paintTitle() {
  const tab = activeTab();
  if (!tab) {
    document.title = 'Relay';
    return;
  }
  if (tab.kind === 'environment') {
    document.title = `${findEnvironment(tab.envId)?.name || 'Environment'} — Relay`;
    return;
  }
  document.title = `${tab.draft?.name || 'Untitled request'} — Relay`;
}

function tabIsDirty(tab) {
  return tab.kind === 'request' && signatureOf(tab.draft) !== tab.savedSignature;
}

function renderDocTabs() {
  if (tabDrag) {
    docTabsNeedRender = true;
    return;
  }
  const host = document.getElementById('doc-tabs');
  if (!host) return;
  const scroll = el('div', { class: 'doc-tab-scroll', role: 'tablist', 'aria-label': 'Open documents' });
  for (const tab of state.tabs) scroll.append(renderDocTab(tab));
  host.replaceChildren(
    scroll,
    el('button', {
      class: 'doc-tab-add',
      text: '+',
      title: 'New request',
      'data-testid': 'tab-new',
      'data-action': 'new-request-tab',
    }),
  );
  paintTitle();
}

function renderDocTab(tab) {
  const label = tab.kind === 'environment'
    ? (findEnvironment(tab.envId)?.name || 'Environment')
    : (tab.draft?.name || 'Untitled request');
  const dirty = tabIsDirty(tab);
  return el('div', {
    class: `doc-tab${tab.id === state.activeTabId ? ' is-active' : ''}`,
    role: 'tab',
    tabindex: '0',
    title: label,
    'aria-selected': tab.id === state.activeTabId ? 'true' : 'false',
    'data-doc-tab': tab.id,
    'data-kind': tab.kind,
    'data-request-id': tab.kind === 'request' ? (tab.loaded?.requestId || '') : '',
    'data-testid': 'doc-tab',
  },
    tab.kind === 'environment'
      ? el('span', { class: 'doc-kind', text: 'ENV' })
      : el('span', { class: `verb ${tab.draft?.method || 'GET'}`, text: tab.draft?.method || 'GET' }),
    el('span', { class: 'doc-tab-label', text: label }),
    dirty ? el('span', { class: 'doc-dirty', title: 'Unsaved changes' }) : null,
    el('button', {
      class: 'doc-tab-close',
      text: '✕',
      title: 'Close',
      'aria-label': `Close ${label}`,
      'data-close-tab': tab.id,
    }),
  );
}

function onTabPointerDown(event) {
  if (tabDrag || event.button !== 0) return;
  const origin = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!origin) return;
  const tabEl = origin.closest('[data-doc-tab]');
  if (!tabEl || origin.closest('[data-close-tab]')) return;
  const scroll = tabEl.parentElement;
  if (!scroll) return;
  tabDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    clientX: event.clientX,
    moved: false,
    el: tabEl,
    scroll,
    order: [...scroll.querySelectorAll('[data-doc-tab]')],
    scrollFrame: 0,
  };
  window.addEventListener('pointermove', onTabPointerMove);
  window.addEventListener('pointerup', onTabPointerEnd);
  window.addEventListener('pointercancel', onTabPointerEnd);
  try { tabEl.setPointerCapture(event.pointerId); } catch { /* untrusted pointers cannot be captured */ }
}

function onTabPointerMove(event) {
  if (!tabDrag || event.pointerId !== tabDrag.pointerId) return;
  tabDrag.clientX = event.clientX;
  if (!tabDrag.moved) {
    const dx = event.clientX - tabDrag.startX;
    const dy = event.clientY - tabDrag.startY;
    if (dx * dx + dy * dy < 16) return;
    tabDrag.moved = true;
    tabDrag.el.classList.add('is-dragging');
    document.body.classList.add('is-tab-dragging');
    const step = () => {
      if (!tabDrag?.moved) return;
      nudgeTabScroll();
      placeDraggedTab(tabDrag.clientX);
      tabDrag.scrollFrame = requestAnimationFrame(step);
    };
    tabDrag.scrollFrame = requestAnimationFrame(step);
  }
  placeDraggedTab(event.clientX);
  event.preventDefault();
}

function nudgeTabScroll() {
  const scroll = tabDrag?.scroll;
  if (!scroll || tabDrag.clientX == null) return;
  const bounds = scroll.getBoundingClientRect();
  const edge = 32;
  if (tabDrag.clientX < bounds.left + edge) scroll.scrollLeft -= 14;
  else if (tabDrag.clientX > bounds.right - edge) scroll.scrollLeft += 14;
}

function placeDraggedTab(clientX) {
  const scroll = tabDrag?.scroll;
  if (!scroll) return;
  const tabs = [...scroll.querySelectorAll('.doc-tab')].filter((node) => node !== tabDrag.el);
  let before = null;
  for (const node of tabs) {
    const rect = node.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      before = node;
      break;
    }
  }
  if (tabDrag.el.nextElementSibling !== before) scroll.insertBefore(tabDrag.el, before);
}

function onTabPointerEnd(event) {
  finishTabDrag(event, event.type === 'pointercancel');
}

function finishTabDrag(event, restore) {
  if (!tabDrag) return;
  if (event && event.pointerId !== tabDrag.pointerId) return;
  const session = tabDrag;
  tabDrag = null;
  window.removeEventListener('pointermove', onTabPointerMove);
  window.removeEventListener('pointerup', onTabPointerEnd);
  window.removeEventListener('pointercancel', onTabPointerEnd);
  cancelAnimationFrame(session.scrollFrame);
  session.el.classList.remove('is-dragging');
  document.body.classList.remove('is-tab-dragging');
  try {
    if (session.el.hasPointerCapture(session.pointerId)) session.el.releasePointerCapture(session.pointerId);
  } catch { /* pointer was not captured */ }
  if (restore && session.scroll) {
    for (const node of session.order) session.scroll.append(node);
    session.moved = false;
  }
  if (session.moved) {
    applyDraggedTabOrder(session.scroll);
    const swallow = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      document.removeEventListener('click', swallow, true);
    };
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 0);
  }
  if (docTabsNeedRender) {
    docTabsNeedRender = false;
    renderDocTabs();
  }
}

function applyDraggedTabOrder(scroll) {
  if (!scroll) return;
  const ids = [...scroll.querySelectorAll('[data-doc-tab]')].map((node) => node.dataset.docTab);
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const next = [];
  for (const id of ids) {
    const tab = byId.get(id);
    if (tab) next.push(tab);
  }
  for (const tab of state.tabs) {
    if (!next.includes(tab)) next.push(tab);
  }
  if (next.length === state.tabs.length && next.every((tab, index) => tab === state.tabs[index])) return;
  state.tabs = next;
  scheduleSave();
}

function paintEnvUse() {
  const button = document.getElementById('env-tab-use');
  const crumb = document.getElementById('env-crumb');
  const tab = activeTab();
  if (!button || !tab || tab.kind !== 'environment') return;
  const inUse = tab.envId === state.activeEnvironmentId;
  button.textContent = inUse ? 'In use' : 'Use';
  button.disabled = inUse;
  button.className = inUse ? 'text-btn' : 'save-btn';
  if (crumb) crumb.textContent = inUse ? 'Active environment' : 'Environment';
}

function renderEnvPane() {
  const tab = activeTab();
  const body = document.getElementById('env-tab-body');
  const name = document.getElementById('env-tab-name');
  if (!tab || tab.kind !== 'environment' || !body || !name) return;
  const env = findEnvironment(tab.envId);
  if (!env) {
    name.value = '';
    name.dataset.envId = '';
    body.replaceChildren(el('div', { class: 'empty-state' }, el('h3', { text: 'This environment is no longer available.' })));
    paintEnvUse();
    return;
  }
  name.dataset.envId = env.id;
  name.value = env.name;
  paintEnvUse();
  body.replaceChildren(
    el('p', { class: 'hint', text: 'These variables override globals with the same name while this environment is active.' }),
    renderVarTable(env.variables, 'env', env.id),
  );
}

function renderEditor() {
  if (!state.draft) return;
  document.getElementById('request-name').value = state.draft.name;
  document.getElementById('method').value = state.draft.method;
  document.getElementById('url').value = state.draft.url;
  paintMethod();
  paintTabs();
  renderReqPanel();
  renderResponse();
  refreshDerived();
}

function renderSidebarList() {
  if (requestDrag) {
    sideListNeedRender = true;
    return;
  }
  const host = document.getElementById('side-list');
  host.replaceChildren();
  if (ui.side === 'collections') host.append(renderCollections());
  else if (ui.side === 'environments') host.append(renderEnvironments());
  else host.append(renderHistory());
  focusEditing();
}

function renderCollections() {
  const wrap = el('div');
  const query = ui.search;
  let shown = 0;
  for (const collection of state.collections) {
    const queryText = query.trim();
    const nameMatch = matches(query, collection.name);
    const collapsed = ui.collapsed.has(collection.id) && !queryText;
    const rendered = collapsed
      ? { node: document.createDocumentFragment(), shown: 0 }
      : renderItemList(collection, collection.items || [], '', query, nameMatch);
    if (queryText && !nameMatch && !rendered.shown) continue;
    shown += 1;
    const head = el('div', { class: 'collection-head' },
      el('button', {
        class: 'icon-btn',
        text: collapsed ? '▸' : '▾',
        title: 'Collapse',
        'data-action': 'toggle-collection',
        'data-collection-id': collection.id,
      }),
      ui.editing?.kind === 'collection' && ui.editing.id === collection.id
        ? el('input', {
          class: 'rename-input',
          'data-field': 'collection-name',
          'data-collection-id': collection.id,
          'data-autofocus': 'true',
          value: collection.name,
          spellcheck: 'false',
        })
        : el('span', { class: 'collection-name', 'data-collection-name': collection.name, text: collection.name }),
      el('span', { class: 'collection-count', text: String(countRequests(collection.items)) }),
      el('span', { class: 'row-actions' },
        el('button', {
          class: 'icon-btn',
          title: 'New folder',
          'aria-label': 'New folder',
          'data-action': 'add-folder',
          'data-collection-id': collection.id,
        }, folderGlyph()),
        el('button', { class: 'icon-btn', text: '+', title: 'New request in this collection', 'data-action': 'add-request', 'data-collection-id': collection.id }),
        el('button', { class: 'icon-btn', text: '✎', title: 'Rename', 'data-action': 'rename-collection', 'data-collection-id': collection.id }),
        el('button', { class: 'icon-btn', text: '⧉', title: 'Duplicate', 'data-action': 'duplicate-collection', 'data-collection-id': collection.id }),
        el('button', { class: 'icon-btn danger', text: '✕', title: 'Delete', 'data-action': 'delete-collection', 'data-collection-id': collection.id }),
      ),
    );
    const body = el('div', {
      class: 'collection-body',
      'data-drop-parent': '',
      'data-collection-id': collection.id,
      'data-drop-index': String((collection.items || []).length),
    });
    if (!collapsed) {
      body.append(rendered.node);
      if (!rendered.shown) body.append(el('div', { class: 'hint', text: 'No requests yet.' }));
    }
    wrap.append(el('section', { class: 'collection', 'data-collection-id': collection.id }, head, collapsed ? null : body));
  }
  if (!shown) {
    wrap.append(el('div', { class: 'empty-state' },
      el('h3', { text: state.collections.length ? 'No matches' : 'No collections yet' }),
      el('p', { text: 'Save a request into a collection, or import a Postman collection.' }),
    ));
  }
  return wrap;
}

function renderItemList(collection, items, parentFolderId, query, ancestorMatch) {
  const frag = document.createDocumentFragment();
  let shown = 0;
  items.forEach((item, index) => {
    if (!item) return;
    if (item.kind === 'folder') {
      const collapsed = ui.collapsed.has(item.id) && !query.trim();
      const nameMatch = ancestorMatch || matches(query, item.name);
      const children = collapsed
        ? { node: document.createDocumentFragment(), shown: 0 }
        : renderItemList(collection, item.items || [], item.id, query, nameMatch);
      if (!ancestorMatch && query.trim() && !matches(query, item.name) && !children.shown) return;
      shown += 1;
      frag.append(renderFolder(collection, item, parentFolderId, index, children.node, collapsed));
      return;
    }
    if (!ancestorMatch && query.trim() && !matches(query, item.name, item.method, item.url)) return;
    shown += 1;
    frag.append(renderRequestRow(collection, item, parentFolderId, index));
  });
  return { node: frag, shown };
}

function renderFolder(collection, folder, parentFolderId, index, childNode, collapsed) {
  const editing = ui.editing?.kind === 'folder' && ui.editing.id === folder.id;
  const head = el('div', {
    class: 'folder-head',
    'data-folder-id': folder.id,
    'data-collection-id': collection.id,
    'data-parent-folder-id': parentFolderId || '',
    'data-index': String(index),
  },
    el('button', {
      class: 'icon-btn',
      text: collapsed ? '▸' : '▾',
      title: 'Collapse',
      'data-action': 'toggle-folder',
      'data-collection-id': collection.id,
      'data-folder-id': folder.id,
    }),
    editing
      ? el('input', {
        class: 'rename-input',
        'data-field': 'folder-name',
        'data-collection-id': collection.id,
        'data-folder-id': folder.id,
        'data-autofocus': 'true',
        value: folder.name,
        spellcheck: 'false',
      })
      : el('span', { class: 'folder-name', 'data-folder-name': folder.name, text: folder.name }),
    el('span', { class: 'collection-count', text: String(countRequests(folder.items)) }),
    el('span', { class: 'row-actions' },
      el('button', {
        class: 'icon-btn',
        title: 'New folder',
        'aria-label': 'New folder',
        'data-action': 'add-folder',
        'data-collection-id': collection.id,
        'data-folder-id': folder.id,
      }, folderGlyph()),
      el('button', {
        class: 'icon-btn',
        text: '+',
        title: 'New request in this folder',
        'data-action': 'add-request',
        'data-collection-id': collection.id,
        'data-folder-id': folder.id,
      }),
      el('button', { class: 'icon-btn', text: '✎', title: 'Rename', 'data-action': 'rename-folder', 'data-collection-id': collection.id, 'data-folder-id': folder.id }),
      el('button', { class: 'icon-btn', text: '⧉', title: 'Duplicate', 'data-action': 'duplicate-folder', 'data-collection-id': collection.id, 'data-folder-id': folder.id }),
      el('button', { class: 'icon-btn danger', text: '✕', title: 'Delete', 'data-action': 'delete-folder', 'data-collection-id': collection.id, 'data-folder-id': folder.id }),
    ),
  );
  if (collapsed) return el('div', { class: 'folder' }, head);
  const empty = childNode.childNodes.length === 0;
  const body = el('div', {
    class: 'folder-body',
    'data-drop-parent': folder.id,
    'data-collection-id': collection.id,
    'data-drop-index': String((folder.items || []).length),
  }, childNode);
  if (empty) body.append(el('div', { class: 'folder-empty', text: 'Empty' }));
  return el('div', { class: 'folder' }, head, body);
}

function renderRequestRow(collection, request, parentFolderId, index) {
  const open = state.tabs.find((tab) => (
    tab.kind === 'request'
    && tab.loaded?.collectionId === collection.id
    && tab.loaded?.requestId === request.id
  ));
  const active = Boolean(open) && open.id === state.activeTabId;
  const editing = ui.editing?.kind === 'request' && ui.editing.id === request.id;
  return el('div', {
    class: `request-item${active ? ' is-active' : ''}${open ? ' is-open' : ''}`,
    'data-request-id': request.id,
    'data-collection-id': collection.id,
    'data-parent-folder-id': parentFolderId || '',
    'data-index': String(index),
    'data-request-name': request.name,
  },
    el('span', { class: `verb ${request.method}`, text: request.method }),
    editing
      ? el('input', {
        class: 'rename-input',
        'data-field': 'request-name',
        'data-collection-id': collection.id,
        'data-request-id': request.id,
        'data-autofocus': 'true',
        value: request.name,
        spellcheck: 'false',
      })
      : el('span', { class: 'request-label', text: request.name, title: request.url }),
    el('span', { class: 'row-actions' },
      el('button', { class: 'icon-btn', text: '⧉', title: 'Duplicate', 'data-action': 'duplicate-request', 'data-collection-id': collection.id, 'data-request-id': request.id }),
      el('button', { class: 'icon-btn', text: '✎', title: 'Rename', 'data-action': 'rename-request', 'data-collection-id': collection.id, 'data-request-id': request.id }),
      el('button', { class: 'icon-btn danger', text: '✕', title: 'Delete', 'data-action': 'delete-request', 'data-collection-id': collection.id, 'data-request-id': request.id }),
    ),
  );
}

function renderEnvironments() {
  const wrap = el('div');
  const query = ui.search;
  wrap.append(el('div', { class: 'globals-card' },
    el('div', { class: 'section-label', text: 'Globals' }),
    el('p', { class: 'hint', text: 'Available in every request. The active environment overrides the same name.' }),
    renderVarTable(state.globals.variables, 'globals', ''),
  ));
  wrap.append(el('p', { class: 'hint side-hint', text: 'Click an environment to edit it in a tab. Use makes it active for requests.' }));
  const envs = state.environments.filter((env) => (
    matches(query, env.name, ...env.variables.map((variable) => `${variable.key} ${variable.value}`))
  ));
  if (!envs.length) wrap.append(el('div', { class: 'empty-state' }, el('h3', { text: 'No environments' })));
  for (const env of envs) wrap.append(renderEnvCard(env));
  return wrap;
}

function renderEnvCard(env) {
  const active = env.id === state.activeEnvironmentId;
  const current = activeTab()?.kind === 'environment' && activeTab().envId === env.id;
  const editing = ui.editing?.kind === 'environment' && ui.editing.id === env.id;
  return el('section', { class: `env-card${active ? ' is-active' : ''}${current ? ' is-current' : ''}`, 'data-env-id': env.id },
    el('div', { class: 'env-head' },
      editing
        ? el('input', { class: 'rename-input', 'data-field': 'env-name', 'data-env-id': env.id, 'data-autofocus': 'true', value: env.name, spellcheck: 'false' })
        : el('span', { class: 'env-name', text: env.name, title: 'Open' }),
      el('button', { class: 'text-btn', text: active ? 'In use' : 'Use', 'data-action': 'use-env', 'data-env-id': env.id }),
      el('span', { class: 'row-actions' },
        el('button', { class: 'icon-btn', text: '✎', title: 'Rename', 'data-action': 'rename-env', 'data-env-id': env.id }),
        el('button', { class: 'icon-btn', text: '⧉', title: 'Duplicate', 'data-action': 'duplicate-env', 'data-env-id': env.id }),
        el('button', { class: 'icon-btn danger', text: '✕', title: 'Delete', 'data-action': 'delete-env', 'data-env-id': env.id }),
      ),
    ),
  );
}

function renderVarTable(vars, scope, envId) {
  const table = el('div', { class: 'var-table', 'data-var-list': scope === 'globals' ? 'globals' : envId });
  table.append(el('div', { class: 'var-head' }, el('span'), el('span', { text: 'Key' }), el('span', { text: 'Value' }), el('span')));
  for (const row of vars) table.append(renderVarRow(row, scope, envId));
  return table;
}

function renderVarRow(row, scope, envId) {
  return el('div', { class: 'var-row', 'data-var-id': row.id, 'data-scope': scope, 'data-env-id': envId || '' },
    el('input', { class: 'check', type: 'checkbox', 'data-field': 'enabled', checked: row.enabled !== false }),
    el('input', { 'data-field': 'key', value: row.key, placeholder: 'name', spellcheck: 'false', autocomplete: 'off' }),
    el('input', { 'data-field': 'value', value: row.value, placeholder: 'value', spellcheck: 'false', autocomplete: 'off' }),
    el('button', { class: 'icon-btn danger', text: '✕', title: 'Remove variable', 'data-action': 'delete-var', 'data-var-id': row.id, 'data-scope': scope, 'data-env-id': envId || '' }),
  );
}

function renderHistory() {
  const wrap = el('div');
  const items = state.history.filter((item) => matches(ui.search, item.method, item.url, item.draft?.name, item.status));
  if (!items.length) {
    wrap.append(el('div', { class: 'empty-state' },
      el('h3', { text: state.history.length ? 'No matches' : 'No history yet' }),
      el('p', { text: 'Requests you send are listed here.' }),
    ));
    return wrap;
  }
  for (const item of items) {
    wrap.append(el('div', { class: 'history-item', 'data-history-id': item.id },
      el('span', { class: `verb ${item.method}`, text: item.method }),
      el('span', { class: 'history-url', text: item.url, title: item.url }),
      el('span', { class: `status-mini ${statusClass(item.error ? 0 : item.status)}`, text: item.status ? String(item.status) : 'ERR' }),
      el('button', { class: 'icon-btn danger', text: '✕', title: 'Remove', 'data-action': 'delete-history', 'data-history-id': item.id }),
    ));
  }
  return wrap;
}

function renderReqPanel() {
  const panel = document.getElementById('req-panel');
  panel.replaceChildren();
  if (ui.reqTab === 'params') panel.append(renderKv('params', 'Query parameters are added to the URL. Disabled rows stay here and are not sent.'));
  else if (ui.reqTab === 'headers') panel.append(renderHeaders());
  else if (ui.reqTab === 'body') panel.append(renderBody());
  else if (ui.reqTab === 'auth') panel.append(renderAuth());
  else if (ui.reqTab === 'curl') panel.append(renderCurl());
  else panel.append(renderSettings());
  const built = currentBuilt();
  updateGenerated(built);
  updateCurlPreview(built);
}

function renderCurl() {
  return el('div', { class: 'curl-view', id: 'curl-preview' },
    el('div', { class: 'curl-toolbar' },
      el('p', { class: 'hint', text: 'Command for the open request after the active environment is applied. It uses curl.exe so PowerShell does not alias it.' }),
      el('button', {
        class: 'text-btn',
        text: 'Copy',
        'data-testid': 'curl-copy',
        'data-action': 'copy-shown-curl',
      }),
    ),
    el('div', { class: 'curl-box' },
      el('pre', { id: 'curl-command', class: 'code-view', 'data-testid': 'curl-command' }),
    ),
    el('p', { id: 'curl-note', class: 'hint', 'data-testid': 'curl-note' }),
  );
}

function updateCurlPreview(built = currentBuilt()) {
  const command = document.getElementById('curl-command');
  const note = document.getElementById('curl-note');
  if (!command || !note) return;
  const curl = RelayCore.toCurl(built);
  command.textContent = curl || (built?.error || 'Enter a URL to see the cURL command for this request.');
  command.classList.toggle('is-empty', !curl);
  const notes = [];
  if (curl && built?.error) notes.push(built.error);
  if (curl && built?.missing?.length) notes.push(`Unresolved: ${built.missing.join(', ')}.`);
  if (curl) notes.push(...(built?.warnings || []));
  note.textContent = notes.join(' ');
  note.className = notes.length ? 'hint is-warn' : 'hint';
}

function renderKv(listName, hint) {
  const rows = listByName(listName);
  const files = listName === 'formdata';
  const table = el('div', { class: `kv-table${files ? ' files' : ''}`, 'data-list': listName });
  const head = files
    ? ['', 'Key', 'Type', 'Value', 'Description', '']
    : ['', 'Key', 'Value', 'Description', ''];
  table.append(el('div', { class: 'kv-head' }, ...head.map((label) => el('span', { text: label }))));
  for (const row of rows) table.append(renderKvRow(listName, row));
  return el('div', {}, table, hint ? el('p', { class: 'hint', text: hint }) : null);
}

function renderKvRow(listName, row) {
  const files = listName === 'formdata';
  const valueCell = files && row.type === 'file'
    ? el('div', { class: 'file-cell' },
      el('button', { class: 'text-btn', text: 'Choose file', 'data-action': 'pick-file', 'data-row-id': row.id }),
      el('span', { text: fileLabel(row.value), title: row.value }),
    )
    : el('input', { 'data-field': 'value', value: row.value, placeholder: 'Value', spellcheck: 'false', autocomplete: 'off' });
  const typeSelect = files ? el('select', { 'data-field': 'type' },
    el('option', { value: 'text', text: 'Text' }),
    el('option', { value: 'file', text: 'File' }),
  ) : null;
  if (typeSelect) typeSelect.value = row.type === 'file' ? 'file' : 'text';
  return el('div', { class: 'kv-row', 'data-id': row.id },
    el('input', { class: 'check', type: 'checkbox', 'data-field': 'enabled', checked: row.enabled !== false }),
    el('input', { 'data-field': 'key', value: row.key, placeholder: 'Key', spellcheck: 'false', autocomplete: 'off' }),
    typeSelect,
    valueCell,
    el('input', { 'data-field': 'description', value: row.description, placeholder: 'Description', spellcheck: 'false' }),
    el('button', { class: 'icon-btn danger', text: '✕', title: 'Remove row', 'data-action': 'remove-row', 'data-row-id': row.id }),
  );
}

function renderHeaders() {
  const wrap = renderKv('headers', 'Auth, Content-Type, Accept, and User-Agent are added automatically when needed.');
  wrap.append(el('div', { class: 'generated' },
    el('div', { class: 'section-label', text: 'Headers that will be sent' }),
    el('div', { id: 'generated-headers' }),
  ));
  return wrap;
}

function renderBody() {
  const mode = state.draft.bodyMode;
  const modes = el('div', { class: 'segmented' },
    modeButton('none', 'none'),
    modeButton('raw', 'raw'),
    modeButton('urlencoded', 'x-www-form-urlencoded'),
    modeButton('formdata', 'form-data'),
  );
  const wrap = el('div', {}, modes);
  if (mode === 'none') wrap.append(el('p', { class: 'hint', text: 'This request will be sent without a body.' }));
  else if (mode === 'raw') {
    wrap.append(el('div', { class: 'segmented' },
      el('select', { id: 'raw-type', 'data-testid': 'raw-type' },
        ...['json', 'text', 'xml', 'html'].map((type) => el('option', { value: type, text: type.toUpperCase(), ...(state.draft.rawType === type ? { selected: '' } : {}) })),
      ),
      state.draft.rawType === 'json' ? el('button', { class: 'text-btn', text: 'Beautify', 'data-testid': 'beautify-body', 'data-action': 'beautify-body' }) : null,
      state.draft.rawType === 'json' ? el('button', { class: 'text-btn', text: 'Minify', 'data-testid': 'minify-body', 'data-action': 'minify-body' }) : null,
    ));
    wrap.append(el('textarea', { id: 'raw-body', 'data-testid': 'raw-body', spellcheck: 'false', value: state.draft.rawBody }));
  } else if (mode === 'urlencoded') wrap.append(renderKv('urlencoded'));
  else wrap.append(renderKv('formdata'));
  return wrap;
}

function modeButton(mode, label) {
  return el('button', {
    class: `text-btn${state.draft.bodyMode === mode ? ' active' : ''}`,
    text: label,
    'data-testid': `body-mode-${mode}`,
    'data-action': 'body-mode',
    'data-mode': mode,
  });
}

function renderAuth() {
  const type = state.draft.authType;
  const auth = state.draft.auth;
  const wrap = el('div', { class: 'auth-form' },
    field('Type', el('select', { id: 'auth-type', 'data-testid': 'auth-type' },
      ...[['none', 'No auth'], ['bearer', 'Bearer token'], ['basic', 'Basic auth'], ['apikey', 'API key']].map(([value, label]) => (
        el('option', { value, text: label, ...(type === value ? { selected: '' } : {}) })
      )),
    )),
  );
  if (type === 'none') wrap.append(el('p', { class: 'hint', text: 'No authorization header will be added by the Auth tab.' }));
  else if (type === 'bearer') wrap.append(field('Token', el('input', { id: 'bearer-token', 'data-testid': 'bearer-token', 'data-auth': 'bearerToken', value: auth.bearerToken, spellcheck: 'false', autocomplete: 'off' })));
  else if (type === 'basic') {
    wrap.append(field('Username', el('input', { id: 'basic-user', 'data-testid': 'basic-user', 'data-auth': 'basicUser', value: auth.basicUser, spellcheck: 'false', autocomplete: 'off' })));
    wrap.append(field('Password', el('input', { id: 'basic-pass', 'data-testid': 'basic-pass', type: 'password', 'data-auth': 'basicPass', value: auth.basicPass, spellcheck: 'false', autocomplete: 'off' })));
  } else {
    wrap.append(field('Key', el('input', { id: 'api-key', 'data-testid': 'api-key', 'data-auth': 'apiKey', value: auth.apiKey, placeholder: 'X-API-Key', spellcheck: 'false' })));
    wrap.append(field('Value', el('input', { id: 'api-value', 'data-testid': 'api-value', 'data-auth': 'apiValue', value: auth.apiValue, spellcheck: 'false' })));
    wrap.append(field('Add to', el('select', { id: 'api-in', 'data-testid': 'api-in', 'data-auth': 'apiIn' },
      el('option', { value: 'header', text: 'Header', ...(auth.apiIn !== 'query' ? { selected: '' } : {}) }),
      el('option', { value: 'query', text: 'Query params', ...(auth.apiIn === 'query' ? { selected: '' } : {}) }),
    )));
  }
  wrap.append(el('p', { class: 'hint', text: 'Auth values can use {{variables}} from the active environment.' }));
  return wrap;
}

function renderSettings() {
  return el('div', { class: 'settings-form' },
    field('Timeout (ms)', el('input', { id: 'timeout', 'data-testid': 'timeout', type: 'number', min: '1000', max: '180000', value: state.draft.timeoutMs })),
    el('label', { class: 'field' },
      el('span', { text: 'Redirects' }),
      el('span', {},
        el('input', { id: 'follow-redirects', 'data-testid': 'follow-redirects', type: 'checkbox', checked: state.draft.followRedirects !== false }),
        ' Follow redirects',
      ),
    ),
    el('label', { class: 'field' },
      el('span', { text: 'Certificates' }),
      el('span', {},
        el('input', { id: 'insecure-tls', 'data-testid': 'insecure-tls', type: 'checkbox', checked: state.draft.insecureTLS === true }),
        ' Accept invalid certificates',
      ),
    ),
    el('p', { class: 'hint', text: 'Use {{name}} in the URL, parameters, headers, body, and auth. Globals apply everywhere, and the active environment wins when a name exists in both. Built-in values: {{$guid}}, {{$timestamp}}, {{$isoTimestamp}}, and {{$randomInt}}.' }),
  );
}

function field(label, control) {
  return el('label', { class: 'field' }, el('span', { text: label }), control);
}

function renderResponse() {
  paintResTabs();
  const meta = document.getElementById('response-meta');
  const toolbar = document.getElementById('res-toolbar');
  const view = document.getElementById('response-view');
  meta.replaceChildren();
  toolbar.replaceChildren();
  view.replaceChildren();
  const response = ui.response;
  if (!response) {
    view.append(el('div', { class: 'empty-state' },
      el('h3', { text: 'Response' }),
      el('p', { text: 'Send a request to see the status, headers, and body.' }),
    ));
    updateCounts();
    return;
  }
  if (response.error && !response.status) {
    meta.append(el('span', { class: 'status-pill s0', text: response.cancelled ? 'Cancelled' : 'Error' }));
    view.append(el('div', { class: 'empty-state' }, el('h3', { text: response.error })));
    updateCounts();
    return;
  }
  meta.append(el('span', { class: `status-pill ${statusClass(response.status)}`, text: `${response.status} ${response.statusText || ''}`.trim() }));
  if (response.timeMs != null) meta.append(el('span', { class: 'meta-bit', text: formatMs(response.timeMs) }));
  if (response.size != null) meta.append(el('span', { class: 'meta-bit', text: RelayCore.formatBytes(response.size) }));
  if (response.contentType) meta.append(el('span', { class: 'meta-bit', text: response.contentType }));
  if (response.redirectCount) meta.append(el('span', { class: 'meta-bit', text: `${response.redirectCount} redirect${response.redirectCount === 1 ? '' : 's'}` }));
  if (response.truncated) meta.append(el('span', { class: 'hint is-warn', text: 'The body was truncated at 8 MB.' }));
  if (response.finalUrl && response.requestUrl && response.finalUrl !== response.requestUrl) {
    meta.append(el('span', { class: 'meta-bit', text: response.finalUrl, title: response.finalUrl }));
  }
  for (const warning of response.warnings || []) meta.append(el('p', { class: 'hint is-warn', text: warning }));

  if (ui.resTab === 'headers') {
    const headers = response.headers || [];
    if (!headers.length) view.append(el('div', { class: 'empty-state' }, el('p', { text: 'No response headers.' })));
    for (const header of headers) {
      view.append(el('div', { class: 'header-line' }, el('b', { text: header.key }), el('span', { text: header.value })));
    }
    updateCounts();
    return;
  }

  toolbar.append(
    el('button', { class: ui.bodyView === 'pretty' ? 'active' : '', text: 'Pretty', 'data-action': 'body-view', 'data-view': 'pretty', 'data-testid': 'res-pretty' }),
    el('button', { class: ui.bodyView === 'raw' ? 'active' : '', text: 'Raw', 'data-action': 'body-view', 'data-view': 'raw', 'data-testid': 'res-raw' }),
    el('button', { text: 'Copy', 'data-action': 'copy-response', 'data-testid': 'res-copy' }),
    el('button', { text: 'Save', 'data-action': 'save-response', 'data-testid': 'res-save' }),
  );

  if (response.isImage && response.bodyBase64) {
    view.append(el('img', { class: 'preview-image', alt: 'Response image', src: `data:${response.contentType || 'image/png'};base64,${response.bodyBase64}` }));
  } else if (response.bodyText == null) {
    view.append(el('div', { class: 'empty-state' },
      el('h3', { text: 'Binary response' }),
      el('p', { text: response.truncated ? 'The response is larger than 8 MB and was truncated.' : 'Save the response to open it in another app.' }),
    ));
  } else if (!response.bodyText) {
    view.append(el('div', { class: 'empty-state' }, el('p', { text: 'The response body is empty.' })));
  } else if (ui.bodyView === 'pretty') {
    const pretty = RelayCore.beautifyJson(response.bodyText);
    const text = pretty.ok ? pretty.text : response.bodyText;
    const pre = el('pre', { class: 'code-view' });
    if (pretty.ok && text.length <= 200000) pre.innerHTML = RelayCore.highlightJson(text);
    else pre.textContent = text;
    view.append(pre);
  } else {
    view.append(el('pre', { class: 'code-view', text: response.bodyText }));
  }
  updateCounts();
}

function ensureListTrailing(listName) {
  const rows = listByName(listName);
  const before = rows.length;
  RelayCore.ensureTrailing(rows, listName === 'formdata');
  if (rows.length === before) return false;
  const table = document.querySelector(`[data-list="${listName}"]`);
  table?.append(renderKvRow(listName, rows[rows.length - 1]));
  return true;
}

function onTableEvent(event) {
  const target = event.target;
  if (target.dataset?.auth) {
    state.draft.auth[target.dataset.auth] = target.value;
    refreshDerived();
    return;
  }
  if (target.id === 'auth-type') {
    state.draft.authType = target.value;
    renderReqPanel();
    refreshDerived();
    return;
  }
  if (target.id === 'raw-type') {
    state.draft.rawType = target.value;
    renderReqPanel();
    refreshDerived();
    return;
  }
  if (target.id === 'raw-body') {
    state.draft.rawBody = target.value;
    refreshDerived();
    return;
  }
  if (target.id === 'timeout') {
    state.draft.timeoutMs = Number(target.value);
    refreshDerived();
    return;
  }
  if (target.id === 'follow-redirects') {
    state.draft.followRedirects = target.checked;
    refreshDerived();
    return;
  }
  if (target.id === 'insecure-tls') {
    state.draft.insecureTLS = target.checked;
    refreshDerived();
    return;
  }
  const rowEl = target.closest?.('.kv-row');
  const listRoot = target.closest?.('[data-list]');
  if (!rowEl || !listRoot) return;
  const listName = listRoot.dataset.list;
  const row = listByName(listName).find((item) => item.id === rowEl.dataset.id);
  if (!row || !target.dataset.field) return;
  if (target.dataset.field === 'type') {
    row.type = target.value;
    renderReqPanel();
    refreshDerived();
    return;
  }
  row[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value;
  ensureListTrailing(listName);
  if (listName === 'params') {
    state.draft.url = RelayCore.applyParamsToUrl(state.draft.url, state.draft.params);
    document.getElementById('url').value = state.draft.url;
  }
  refreshDerived();
}

async function onPanelClick(event) {
  const action = event.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'copy-shown-curl') {
    copyCurl();
    return;
  }
  if (action.dataset.action === 'body-mode') {
    state.draft.bodyMode = action.dataset.mode;
    renderReqPanel();
    refreshDerived();
    return;
  }
  if (action.dataset.action === 'beautify-body' || action.dataset.action === 'minify-body') {
    const result = action.dataset.action === 'minify-body'
      ? RelayCore.minifyJson(state.draft.rawBody)
      : RelayCore.beautifyJson(state.draft.rawBody);
    if (!result.ok) flash(result.error, 'error');
    else {
      state.draft.rawBody = result.text;
      const box = document.getElementById('raw-body');
      if (box) box.value = result.text;
      refreshDerived();
      flash(action.dataset.action === 'minify-body' ? 'JSON minified.' : 'JSON beautified.');
    }
    return;
  }
  const listRoot = action.closest('[data-list]');
  if (!listRoot) return;
  const listName = listRoot.dataset.list;
  const rows = listByName(listName);
  const row = rows.find((item) => item.id === action.dataset.rowId);
  if (action.dataset.action === 'remove-row') {
    const index = rows.findIndex((item) => item.id === action.dataset.rowId);
    if (index >= 0) rows.splice(index, 1);
    RelayCore.ensureTrailing(rows, listName === 'formdata');
    if (listName === 'params') {
      state.draft.url = RelayCore.applyParamsToUrl(state.draft.url, state.draft.params);
      document.getElementById('url').value = state.draft.url;
    }
    renderReqPanel();
    refreshDerived();
    return;
  }
  if (action.dataset.action === 'pick-file' && row) {
    const picked = await window.relay.pickFile();
    if (!picked) return;
    row.value = picked;
    row.type = 'file';
    renderReqPanel();
    refreshDerived();
  }
}

function onUrlInput() {
  state.draft.url = document.getElementById('url').value;
  state.draft.params = RelayCore.ensureTrailing(RelayCore.syncParamsFromUrl(state.draft.url, state.draft.params));
  if (ui.reqTab === 'params') renderReqPanel();
  refreshDerived();
}

function activateTab(id) {
  const next = state.tabs.find((tab) => tab.id === id);
  if (!next || next.id === state.activeTabId) return;
  captureRequestTab();
  state.activeTabId = next.id;
  if (next.kind === 'request') showRequestTab(next);
  mirrorSending();
  renderAll();
  scheduleSave();
  requestAnimationFrame(() => {
    document.querySelector('#doc-tabs .doc-tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function confirmCloseTab(tab) {
  if (tab.kind !== 'request') return true;
  const name = tab.draft.name || 'Untitled request';
  if (signatureOf(tab.draft) !== tab.savedSignature) {
    return confirm(`“${name}” has unsaved changes. Close it anyway?`);
  }
  const keptInHistory = tab.historyId && state.history.some((item) => item.id === tab.historyId);
  if (!tab.loaded && !keptInHistory && requestHasContent(tab.draft)) {
    return confirm(`Close “${name}”? It is not saved in a collection.`);
  }
  return true;
}

function closeTab(id, { force = false } = {}) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return false;
  const tab = state.tabs[index];
  if (!force && !confirmCloseTab(tab)) return false;
  const wasActive = state.activeTabId === id;
  state.tabs.splice(index, 1);
  if (wasActive) {
    const neighbor = state.tabs[index] || state.tabs[index - 1] || null;
    state.activeTabId = neighbor ? neighbor.id : null;
    if (neighbor?.kind === 'request') showRequestTab(neighbor);
    else if (!neighbor) {
      state.loaded = null;
      ui.response = null;
    }
    mirrorSending();
  }
  renderAll();
  scheduleSave();
  return true;
}

function closeTabsWhere(predicate) {
  const ids = state.tabs.filter(predicate).map((tab) => tab.id);
  for (const id of ids) closeTab(id, { force: true });
  return ids.length;
}

function openRequestTab(collectionId, requestId) {
  const existing = state.tabs.find((tab) => (
    tab.kind === 'request'
    && tab.loaded?.collectionId === collectionId
    && tab.loaded?.requestId === requestId
  ));
  if (existing) {
    if (existing.id !== state.activeTabId) activateTab(existing.id);
    return existing;
  }
  const request = findRequest(collectionId, requestId);
  if (!request) return null;
  const tab = makeRequestTab(request, { collectionId, requestId });
  state.tabs.push(tab);
  activateTab(tab.id);
  return tab;
}

function openNewRequestTab(draft, loaded) {
  const tab = makeRequestTab(draft, loaded);
  state.tabs.push(tab);
  activateTab(tab.id);
  return tab;
}

function openEnvironmentTab(envId, { focusName = false } = {}) {
  if (!findEnvironment(envId)) return null;
  let tab = state.tabs.find((item) => item.kind === 'environment' && item.envId === envId);
  if (!tab) {
    tab = { id: RelayCore.newId(), kind: 'environment', envId };
    state.tabs.push(tab);
  }
  if (tab.id !== state.activeTabId) activateTab(tab.id);
  if (focusName) focusLater('env-tab-name', true);
  return tab;
}

function newRequest() {
  openNewRequestTab(RelayCore.createEmptyDraft(), null);
  focusLater('url');
}

function addBlankRequest(collectionId, folderId) {
  const collection = findCollection(collectionId);
  const list = parentList(collection, folderId || '');
  if (!list) return;
  const request = { id: RelayCore.newId(), ...RelayCore.normalizeRequest({ ...RelayCore.createEmptyDraft(), name: 'New request' }) };
  list.push(request);
  if (folderId) ui.collapsed.delete(folderId);
  ui.collapsed.delete(collectionId);
  openRequestTab(collectionId, request.id);
  focusLater('request-name', true);
}

function addFolder(collectionId, parentFolderId) {
  const collection = findCollection(collectionId);
  const list = parentList(collection, parentFolderId || '');
  if (!list) return null;
  const folder = { kind: 'folder', id: RelayCore.newId(), name: 'New folder', items: [] };
  list.push(folder);
  if (parentFolderId) ui.collapsed.delete(parentFolderId);
  ui.collapsed.delete(collectionId);
  ui.editing = { kind: 'folder', id: folder.id };
  renderSidebarList();
  scheduleSave();
  return folder;
}

function addCollection(name, { edit = false } = {}) {
  const collection = { id: RelayCore.newId(), name: name || 'New collection', items: [] };
  state.collections.push(collection);
  if (edit) ui.editing = { kind: 'collection', id: collection.id };
  scheduleSave();
  return collection;
}

function saveInPlace() {
  const tab = activeRequestTab();
  if (!tab) return;
  if (!tab.loaded) {
    openSaveModal();
    return;
  }
  const collection = findCollection(tab.loaded.collectionId);
  const request = findRequest(tab.loaded.collectionId, tab.loaded.requestId);
  if (!collection || !request) {
    tab.loaded = null;
    state.loaded = null;
    openSaveModal();
    return;
  }
  const normalized = RelayCore.normalizeRequest(tab.draft);
  const id = request.id;
  Object.keys(request).forEach((key) => { if (key !== 'id') delete request[key]; });
  Object.assign(request, normalized, { id });
  tab.savedSignature = signatureOf(tab.draft);
  state.loaded = tab.loaded;
  renderSidebarList();
  refreshDerived();
  flash('Saved.');
}

function openSaveModal() {
  const tab = activeRequestTab();
  if (!tab) return;
  const name = el('input', { id: 'modal-request-name', 'data-testid': 'modal-request-name', value: tab.draft.name || 'Untitled request', spellcheck: 'false' });
  const select = el('select', { id: 'modal-collection', 'data-testid': 'modal-collection' });
  for (const collection of state.collections) select.append(new Option(collection.name, collection.id));
  if (tab.loaded?.collectionId) select.value = tab.loaded.collectionId;
  const created = el('input', { id: 'modal-new-collection', 'data-testid': 'modal-new-collection', placeholder: 'New collection name', spellcheck: 'false' });
  const folderSelect = el('select', { id: 'modal-folder', 'data-testid': 'modal-folder' });
  const folderField = field('Folder', folderSelect);
  const fillFolders = () => {
    const collection = findCollection(select.value);
    folderSelect.replaceChildren();
    for (const option of folderChoices(collection)) folderSelect.append(new Option(option.label, option.id));
    const currentFolder = collection && tab.loaded?.collectionId === collection.id
      ? folderIdOfRequest(collection, tab.loaded.requestId)
      : '';
    if ([...folderSelect.options].some((option) => option.value === currentFolder)) folderSelect.value = currentFolder;
    folderField.hidden = folderSelect.options.length < 2;
  };
  select.addEventListener('change', fillFolders);
  fillFolders();
  const error = el('p', { class: 'form-error' });
  openModal({
    title: 'Save request',
    body: el('div', {},
      field('Request name', name),
      state.collections.length ? field('Collection', select) : null,
      state.collections.length ? folderField : null,
      field('Or create a collection', created),
      error,
    ),
    confirmTestId: 'modal-confirm',
    onConfirm: () => {
      const requestName = name.value.trim() || 'Untitled request';
      const newName = created.value.trim();
      let collection = newName ? addCollection(newName) : findCollection(select.value);
      if (!collection) {
        error.textContent = 'Choose a collection or enter a new name.';
        return false;
      }
      const list = newName ? collection.items : parentList(collection, folderSelect.value);
      if (!list) {
        error.textContent = 'That folder is no longer available.';
        return false;
      }
      tab.draft.name = requestName;
      document.getElementById('request-name').value = requestName;
      const request = { id: RelayCore.newId(), ...RelayCore.normalizeRequest(tab.draft) };
      list.push(request);
      if (!newName && folderSelect.value) ui.collapsed.delete(folderSelect.value);
      tab.loaded = { collectionId: collection.id, requestId: request.id };
      state.loaded = tab.loaded;
      tab.savedSignature = signatureOf(tab.draft);
      ui.editing = null;
      renderSidebarList();
      refreshDerived();
      flash('Saved.');
      return true;
    },
  });
}

function duplicateRequest(collectionId, requestId) {
  const collection = findCollection(collectionId);
  const located = collection ? locateRequest(collection, requestId) : null;
  if (!located) return;
  const copy = withFreshRowIds(RelayCore.normalizeRequest(located.item));
  copy.name = `${located.item.name} copy`;
  const created = { id: RelayCore.newId(), ...copy };
  located.items.splice(located.index + 1, 0, created);
  openRequestTab(collection.id, created.id);
}

function deleteRequest(collectionId, requestId) {
  const collection = findCollection(collectionId);
  const located = collection ? locateRequest(collection, requestId) : null;
  if (!located) return;
  if (!confirm(`Delete “${located.item.name}”?`)) return;
  located.items.splice(located.index, 1);
  const closed = closeTabsWhere((tab) => (
    tab.kind === 'request' && tab.loaded?.collectionId === collectionId && tab.loaded?.requestId === requestId
  ));
  if (!closed) renderSidebarList();
  scheduleSave();
}

function requestIdsIn(items) {
  const ids = [];
  walkItems(items, (item) => {
    ids.push(item.id);
    return null;
  });
  return ids;
}

function deleteFolder(collectionId, folderId) {
  const collection = findCollection(collectionId);
  const folder = findFolder(collection, folderId);
  if (!folder) return;
  const noun = countRequests(folder.items) ? `folder “${folder.name}” and everything inside it` : `folder “${folder.name}”`;
  if (!confirm(`Delete ${noun}?`)) return;
  const removed = new Set(requestIdsIn(folder.items));
  const parent = parentItemsOf(collection.items, folderId);
  if (!parent) return;
  parent.splice(parent.index, 1);
  const closed = closeTabsWhere((tab) => (
    tab.kind === 'request' && tab.loaded?.collectionId === collectionId && removed.has(tab.loaded.requestId)
  ));
  if (!closed) renderSidebarList();
  scheduleSave();
}

function parentItemsOf(items, folderId) {
  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];
    if (item?.kind !== 'folder') continue;
    if (item.id === folderId) return { items, index };
    const nested = parentItemsOf(item.items, folderId);
    if (nested) return nested;
  }
  return null;
}

function duplicateFolder(collectionId, folderId) {
  const collection = findCollection(collectionId);
  const parent = parentItemsOf(collection?.items, folderId);
  if (!parent) return;
  const copy = cloneItems([parent.items[parent.index]])[0];
  copy.name = `${parent.items[parent.index].name} copy`;
  parent.items.splice(parent.index + 1, 0, copy);
  ui.editing = null;
  renderSidebarList();
  scheduleSave();
}

function moveRequest(fromCollectionId, requestId, drop) {
  const fromCollection = findCollection(fromCollectionId);
  const toCollection = findCollection(drop?.collectionId);
  if (!fromCollection || !toCollection) return false;
  const from = locateRequest(fromCollection, requestId);
  const destItems = parentList(toCollection, drop.parentFolderId || '');
  if (!from || !destItems) return false;
  let index = Number(drop.index);
  if (!Number.isFinite(index)) index = destItems.length;
  if (from.items === destItems && (index === from.index || index === from.index + 1)) return false;
  const [request] = from.items.splice(from.index, 1);
  if (from.items === destItems && from.index < index) index -= 1;
  index = Math.max(0, Math.min(index, destItems.length));
  destItems.splice(index, 0, request);
  if (fromCollection.id !== toCollection.id) {
    for (const tab of state.tabs) {
      if (tab.kind === 'request' && tab.loaded?.collectionId === fromCollection.id && tab.loaded?.requestId === requestId) {
        tab.loaded = { collectionId: toCollection.id, requestId };
      }
    }
    if (state.loaded?.collectionId === fromCollection.id && state.loaded?.requestId === requestId) {
      state.loaded = { collectionId: toCollection.id, requestId };
    }
  }
  if (drop.parentFolderId) ui.collapsed.delete(drop.parentFolderId);
  ui.collapsed.delete(toCollection.id);
  scheduleSave();
  return true;
}

function deleteCollection(id) {
  const collection = findCollection(id);
  if (!collection || !confirm(`Delete “${collection.name}” and everything in it?`)) return;
  state.collections = state.collections.filter((item) => item.id !== id);
  const closed = closeTabsWhere((tab) => tab.kind === 'request' && tab.loaded?.collectionId === id);
  if (!closed) renderSidebarList();
  scheduleSave();
}

function duplicateCollection(id) {
  const collection = findCollection(id);
  if (!collection) return;
  state.collections.push({
    id: RelayCore.newId(),
    name: `${collection.name} copy`,
    items: cloneItems(collection.items),
  });
  renderSidebarList();
  scheduleSave();
}

function createEnvironment(name, variables, { edit = false, activate = true, open = true } = {}) {
  const env = {
    id: RelayCore.newId(),
    name: name || 'New environment',
    variables: (variables || []).map((variable) => ({
      id: RelayCore.newId(),
      key: String(variable.key ?? ''),
      value: String(variable.value ?? ''),
      description: '',
      enabled: variable.enabled !== false,
    })),
  };
  RelayCore.ensureVarTrailing(env.variables);
  state.environments.push(env);
  if (activate) state.activeEnvironmentId = env.id;
  if (open) openEnvironmentTab(env.id, { focusName: edit });
  else {
    refreshEnvSelect();
    if (ui.side === 'environments') renderSidebarList();
    refreshDerived();
    scheduleSave();
  }
  return env.id;
}

function duplicateEnvironment(id) {
  const env = findEnvironment(id);
  if (!env) return;
  createEnvironment(`${env.name} copy`, RelayCore.stripVars(env.variables), { activate: false });
}

function deleteEnvironment(id) {
  const env = findEnvironment(id);
  if (!env || !confirm(`Delete environment “${env.name}”?`)) return;
  state.environments = state.environments.filter((item) => item.id !== id);
  if (state.activeEnvironmentId === id) state.activeEnvironmentId = null;
  const closed = closeTabsWhere((tab) => tab.kind === 'environment' && tab.envId === id);
  if (!closed) {
    refreshEnvSelect();
    renderSidebarList();
    refreshDerived();
  }
  scheduleSave();
}

function loadHistory(id) {
  const item = state.history.find((entry) => entry.id === id);
  if (!item?.draft) return;
  const existing = state.tabs.find((tab) => tab.kind === 'request' && tab.historyId === id);
  if (existing) {
    if (existing.id !== state.activeTabId) activateTab(existing.id);
    return;
  }
  const tab = makeRequestTab(item.draft, null);
  tab.historyId = id;
  state.tabs.push(tab);
  activateTab(tab.id);
}

function pushHistory(built, result, draft) {
  const snapshot = RelayCore.normalizeRequest(draft || state.draft);
  if (snapshot.rawBody.length > 100000) snapshot.rawBody = `${snapshot.rawBody.slice(0, 100000)}\n… truncated in history`;
  state.history.unshift({
    id: RelayCore.newId(),
    at: Date.now(),
    method: built.request.method,
    url: built.request.url,
    status: result.status ?? null,
    ok: !result.error && result.status >= 200 && result.status < 400,
    timeMs: result.timeMs || 0,
    error: result.error || null,
    draft: snapshot,
  });
  state.history = state.history.slice(0, 50);
}

async function sendCurrent() {
  const tab = activeRequestTab();
  if (!tab) return { error: 'Open a request to send.', cancelled: true };
  if (tab.sending) {
    await window.relay.cancel(tab.inflightId);
    return { error: 'Cancelled', cancelled: true };
  }
  const built = currentBuilt();
  refreshDerived();
  if (!built.ok) {
    tab.response = { error: built.error, warnings: built.warnings, missing: built.missing };
    ui.response = tab.response;
    renderResponse();
    return ui.response;
  }
  if (built.missing.length) {
    const proceed = confirm(`These variables are not defined: ${built.missing.join(', ')}.\n\nSend the request anyway?`);
    if (!proceed) return { error: 'Cancelled', cancelled: true };
  }
  const generation = (tab.sendGeneration || 0) + 1;
  tab.sendGeneration = generation;
  tab.sending = true;
  tab.inflightId = RelayCore.newId();
  mirrorSending();
  renderStatus();
  try {
    const result = await window.relay.send({ requestId: tab.inflightId, ...built.request });
    if (tab.sendGeneration !== generation || !state.tabs.includes(tab)) return result;
    tab.response = {
      ...result,
      warnings: [...built.warnings, ...(result?.warnings || [])],
      missing: built.missing,
      requestUrl: built.request.url,
    };
    if (!result?.cancelled) pushHistory(built, result || {}, tab.draft);
    if (activeRequestTab() === tab) ui.response = tab.response;
    if (activeRequestTab() === tab) renderResponse();
    if (ui.side === 'history') renderSidebarList();
    scheduleSave();
    return tab.response;
  } finally {
    if (tab.sendGeneration === generation) {
      tab.sending = false;
      tab.inflightId = null;
      if (activeRequestTab() === tab) {
        mirrorSending();
        renderStatus();
      }
    }
  }
}

async function copyCurl() {
  const curl = RelayCore.toCurl(currentBuilt());
  if (!curl) {
    flash('Enter a URL before copying cURL.', 'error');
    return;
  }
  await window.relay.copy(curl);
  flash('cURL copied. It uses curl.exe so PowerShell does not intercept it.');
}

async function copyResponse() {
  if (ui.response?.bodyText == null) {
    flash('There is no text body to copy.', 'error');
    return;
  }
  await window.relay.copy(ui.response.bodyText);
  flash('Response copied.');
}

async function saveResponse() {
  const response = ui.response;
  if (!response || (response.bodyText == null && !response.bodyBase64)) {
    flash('There is no complete response to save.', 'error');
    return;
  }
  const pretty = response.bodyText != null && ui.bodyView === 'pretty' ? RelayCore.beautifyJson(response.bodyText) : null;
  const result = await window.relay.saveFile(response.bodyText != null
    ? { defaultName: pretty?.ok ? 'response.json' : 'response.txt', text: pretty?.ok ? pretty.text : response.bodyText }
    : { defaultName: 'response.bin', base64: response.bodyBase64 });
  if (result && !result.canceled) flash('Response saved.');
}

function openBeautifier() {
  const input = el('textarea', { id: 'beautify-input', 'data-testid': 'beautify-input', spellcheck: 'false', placeholder: '{ "paste": "json" }' });
  const output = el('pre', { class: 'code-view', 'data-testid': 'beautify-output' });
  const error = el('p', { class: 'form-error', 'data-testid': 'beautify-error' });
  const run = (kind) => {
    const result = kind === 'minify' ? RelayCore.minifyJson(input.value) : RelayCore.beautifyJson(input.value);
    error.textContent = result.ok ? '' : result.error;
    output.replaceChildren();
    if (!result.ok) return;
    input.value = result.text;
    if (result.text.length > 200000) output.textContent = result.text;
    else output.innerHTML = RelayCore.highlightJson(result.text);
  };
  openModal({
    title: 'JSON beautifier',
    wide: true,
    body: el('div', {},
      input,
      el('div', { class: 'segmented' },
        el('button', { class: 'text-btn', text: 'Beautify', 'data-testid': 'beautify-run', onclick: () => run('beautify') }),
        el('button', { class: 'text-btn', text: 'Minify', 'data-testid': 'beautify-minify', onclick: () => run('minify') }),
        el('button', { class: 'text-btn', text: 'Copy', onclick: async () => { await window.relay.copy(input.value); flash('JSON copied.'); } }),
      ),
      error,
      el('div', { class: 'beautify-box' }, output),
    ),
  });
}

function openImportChoice(workspace) {
  openModal({
    title: 'Import Relay workspace',
    body: el('div', {},
      el('p', { class: 'hint', text: 'Replace this workspace, or merge the imported collections and environments into it.' }),
    ),
    confirmLabel: 'Merge',
    extraLabel: 'Replace',
    onConfirm: () => { mergeWorkspace(workspace); return true; },
    onExtra: () => {
      if (!confirm('Replace the current workspace on this PC?')) return false;
      applyWorkspace(workspace);
      ui.response = null;
      renderAll();
      scheduleSave();
      flash('Workspace replaced.');
      return true;
    },
  });
}

function mergeWorkspace(workspace) {
  const incoming = RelayCore.sanitizeWorkspace(workspace);
  for (const variable of incoming.globals.variables) {
    const existing = state.globals.variables.find((item) => item.key === variable.key);
    if (existing) existing.value = variable.value;
    else state.globals.variables.unshift({ ...variable, id: RelayCore.newId() });
  }
  RelayCore.ensureVarTrailing(state.globals.variables);
  for (const env of incoming.environments) {
    state.environments.push({ ...env, id: RelayCore.newId() });
    RelayCore.ensureVarTrailing(state.environments[state.environments.length - 1].variables);
  }
  for (const collection of incoming.collections) {
    state.collections.push({
      id: RelayCore.newId(),
      name: collection.name,
      items: cloneItems(collection.items),
    });
  }
  state.history = [...incoming.history, ...state.history].slice(0, 50);
  refreshEnvSelect();
  renderSidebarList();
  refreshDerived();
  flash('Workspace merged.');
}

async function onImport() {
  const picked = await window.relay.importWorkspace();
  if (!picked || picked.canceled) return;
  let data;
  try {
    data = JSON.parse(picked.text);
  } catch (err) {
    flash(`Could not parse JSON: ${err.message}`, 'error');
    return;
  }
  const imported = RelayCore.readImported(data);
  if (imported.kind === 'unknown') {
    flash('Use a Relay workspace, a Postman collection, or a Postman environment.', 'error');
    return;
  }
  if (imported.kind === 'postman-collection') {
    const collection = RelayCore.sanitizeCollection(imported.collection);
    if (!collection) {
      flash('That collection could not be imported.', 'error');
      return;
    }
    state.collections.push(collection);
    ui.side = 'collections';
    paintSideSwitch();
    renderSidebarList();
    scheduleSave();
    flash(`Imported collection “${imported.collection.name}”.`);
    return;
  }
  if (imported.kind === 'postman-environment') {
    RelayCore.ensureVarTrailing(imported.environment.variables);
    state.environments.push(imported.environment);
    if (!state.activeEnvironmentId) state.activeEnvironmentId = imported.environment.id;
    ui.side = 'environments';
    openEnvironmentTab(imported.environment.id);
    flash(`Imported environment “${imported.environment.name}”.`);
    return;
  }
  openImportChoice(imported.workspace);
}

async function onExport() {
  const result = await window.relay.exportWorkspace(JSON.stringify(workspacePayload(), null, 2));
  if (result && !result.canceled) flash('Workspace exported.');
}

function openModal(options) {
  closeModal();
  const confirm = el('button', {
    class: 'save-btn',
    text: options.confirmLabel || 'Save',
    'data-testid': options.confirmTestId || 'modal-confirm',
    onclick: () => { if (options.onConfirm?.() !== false) closeModal(); },
  });
  const footer = el('div', { class: 'modal-foot' },
    options.onExtra ? el('button', { class: 'text-btn', text: options.extraLabel || 'More', onclick: () => { if (options.onExtra() !== false) closeModal(); } }) : null,
    el('button', { class: 'text-btn', text: 'Close', 'data-testid': 'modal-close', onclick: closeModal }),
    options.onConfirm ? confirm : null,
  );
  const back = el('div', { class: 'modal-back', id: 'modal-back' },
    el('div', { class: `modal${options.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-head' },
        el('h2', { text: options.title }),
        el('button', { class: 'icon-btn', text: '✕', title: 'Close', 'data-testid': 'modal-x', onclick: closeModal }),
      ),
      el('div', { class: 'modal-body' }, options.body),
      options.onConfirm || options.onExtra ? footer : el('div', { class: 'modal-foot' }, el('button', { class: 'text-btn', text: 'Close', 'data-testid': 'modal-close', onclick: closeModal })),
    ),
  );
  back.addEventListener('mousedown', (event) => { if (event.target === back) closeModal(); });
  document.getElementById('modal-root').append(back);
  const focusable = back.querySelector('input, textarea, select, button');
  focusable?.focus();
}

function closeModal() {
  document.getElementById('modal-root').replaceChildren();
}

function handleSideAction(action) {
  const collectionId = action.dataset.collectionId;
  const requestId = action.dataset.requestId;
  const envId = action.dataset.envId;
  switch (action.dataset.action) {
    case 'toggle-collection':
      if (ui.collapsed.has(collectionId)) ui.collapsed.delete(collectionId);
      else ui.collapsed.add(collectionId);
      renderSidebarList();
      break;
    case 'rename-collection':
      ui.editing = { kind: 'collection', id: collectionId };
      renderSidebarList();
      break;
    case 'delete-collection':
      deleteCollection(collectionId);
      break;
    case 'duplicate-collection':
      duplicateCollection(collectionId);
      break;
    case 'add-request':
      addBlankRequest(collectionId, action.dataset.folderId || '');
      break;
    case 'add-folder':
      addFolder(collectionId, action.dataset.folderId || '');
      break;
    case 'toggle-folder':
      if (ui.collapsed.has(action.dataset.folderId)) ui.collapsed.delete(action.dataset.folderId);
      else ui.collapsed.add(action.dataset.folderId);
      renderSidebarList();
      break;
    case 'rename-folder':
      ui.editing = { kind: 'folder', id: action.dataset.folderId };
      renderSidebarList();
      break;
    case 'duplicate-folder':
      duplicateFolder(collectionId, action.dataset.folderId);
      break;
    case 'delete-folder':
      deleteFolder(collectionId, action.dataset.folderId);
      break;
    case 'rename-request':
      ui.editing = { kind: 'request', id: requestId };
      renderSidebarList();
      break;
    case 'duplicate-request':
      duplicateRequest(collectionId, requestId);
      break;
    case 'delete-request':
      deleteRequest(collectionId, requestId);
      break;
    case 'use-env':
      state.activeEnvironmentId = envId;
      refreshEnvSelect();
      renderSidebarList();
      paintEnvUse();
      refreshDerived();
      break;
    case 'rename-env':
      ui.editing = { kind: 'environment', id: envId };
      renderSidebarList();
      break;
    case 'duplicate-env':
      duplicateEnvironment(envId);
      break;
    case 'delete-env':
      deleteEnvironment(envId);
      break;
    case 'delete-var': {
      const rows = varList(action.dataset.scope, action.dataset.envId);
      const index = rows.findIndex((row) => row.id === action.dataset.varId);
      if (index >= 0) rows.splice(index, 1);
      RelayCore.ensureVarTrailing(rows);
      renderSidebarList();
      if (action.dataset.scope === 'env' && activeTab()?.kind === 'environment' && activeTab().envId === action.dataset.envId) {
        renderEnvPane();
      }
      refreshDerived();
      break;
    }
    case 'delete-history':
      state.history = state.history.filter((item) => item.id !== action.dataset.historyId);
      renderSidebarList();
      scheduleSave();
      break;
    default:
      break;
  }
}

function onSideInput(event) {
  const target = event.target;
  const field = target.dataset.field;
  if (field === 'collection-name') {
    const collection = findCollection(target.dataset.collectionId);
    if (collection) collection.name = target.value;
    scheduleSave();
    return;
  }
  if (field === 'folder-name') {
    const folder = findFolder(findCollection(target.dataset.collectionId), target.dataset.folderId);
    if (folder) folder.name = target.value;
    scheduleSave();
    return;
  }
  if (field === 'request-name') {
    const request = findRequest(target.dataset.collectionId, target.dataset.requestId);
    if (request) request.name = target.value;
    for (const tab of state.tabs) {
      if (tab.kind !== 'request' || tab.loaded?.collectionId !== target.dataset.collectionId || tab.loaded?.requestId !== target.dataset.requestId) continue;
      tab.draft.name = target.value;
      const saved = findRequest(target.dataset.collectionId, target.dataset.requestId);
      if (saved && signatureOf(tab.draft) === signatureOf(saved)) tab.savedSignature = signatureOf(tab.draft);
    }
    const current = activeRequestTab();
    if (current?.loaded?.collectionId === target.dataset.collectionId && current.loaded?.requestId === target.dataset.requestId) {
      document.getElementById('request-name').value = target.value;
      paintCrumb();
    }
    renderDocTabs();
    scheduleSave();
    return;
  }
  if (field === 'env-name') {
    const env = findEnvironment(target.dataset.envId);
    if (!env) return;
    env.name = target.value;
    refreshEnvSelect();
    const sideLabel = document.querySelector(`#side-list [data-env-id="${CSS.escape(env.id)}"] .env-name`);
    if (sideLabel && sideLabel !== target) sideLabel.textContent = target.value;
    const tabName = document.getElementById('env-tab-name');
    if (tabName && tabName !== target && activeTab()?.kind === 'environment' && activeTab().envId === env.id) {
      tabName.value = target.value;
    }
    renderDocTabs();
    renderStatus();
    scheduleSave();
    return;
  }
  const host = target.closest('[data-var-id]');
  if (!host || !field) return;
  const rows = varList(host.dataset.scope, host.dataset.envId);
  const row = rows.find((item) => item.id === host.dataset.varId);
  if (!row) return;
  row[field] = target.type === 'checkbox' ? target.checked : target.value;
  const before = rows.length;
  RelayCore.ensureVarTrailing(rows);
  if (rows.length !== before) {
    document.querySelector(`[data-var-list="${host.dataset.scope === 'globals' ? 'globals' : host.dataset.envId}"]`)
      ?.append(renderVarRow(rows[rows.length - 1], host.dataset.scope, host.dataset.envId));
  }
  refreshDerived();
}

function commitEditing(event) {
  const field = event.target?.dataset?.field;
  if (!ui.editing || !['collection-name', 'request-name', 'folder-name', 'env-name'].includes(field)) return;
  setTimeout(() => {
    if (!ui.editing) return;
    ui.editing = null;
    renderSidebarList();
  }, 0);
}

function clearRequestDropMarkers() {
  document.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-into').forEach((node) => {
    node.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-into');
  });
}

function onRequestPointerDown(event) {
  if (requestDrag || tabDrag || event.button !== 0) return;
  const origin = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!origin || origin.closest('button, input, textarea, select')) return;
  const row = origin.closest('#side-list .request-item');
  if (!row) return;
  requestDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    moved: false,
    el: row,
    collectionId: row.dataset.collectionId,
    requestId: row.dataset.requestId,
    drop: null,
    scrollFrame: 0,
  };
  window.addEventListener('pointermove', onRequestPointerMove);
  window.addEventListener('pointerup', onRequestPointerEnd);
  window.addEventListener('pointercancel', onRequestPointerEnd);
}

function onRequestPointerMove(event) {
  if (!requestDrag || event.pointerId !== requestDrag.pointerId) return;
  requestDrag.clientX = event.clientX;
  requestDrag.clientY = event.clientY;
  if (!requestDrag.moved) {
    const dx = event.clientX - requestDrag.startX;
    const dy = event.clientY - requestDrag.startY;
    if (dx * dx + dy * dy < 16) return;
    requestDrag.moved = true;
    requestDrag.el.classList.add('is-dragging');
    document.body.classList.add('is-request-dragging');
    const step = () => {
      if (!requestDrag?.moved) return;
      nudgeRequestScroll();
      updateRequestDrop(requestDrag.clientX, requestDrag.clientY);
      requestDrag.scrollFrame = requestAnimationFrame(step);
    };
    requestDrag.scrollFrame = requestAnimationFrame(step);
  }
  updateRequestDrop(event.clientX, event.clientY);
  event.preventDefault();
}

function nudgeRequestScroll() {
  const scroller = document.getElementById('side-list');
  if (!scroller || requestDrag?.clientY == null) return;
  const bounds = scroller.getBoundingClientRect();
  const edge = 28;
  if (requestDrag.clientY < bounds.top + edge) scroller.scrollTop -= 12;
  else if (requestDrag.clientY > bounds.bottom - edge) scroller.scrollTop += 12;
}

function smallestRowHit(selector, x, y) {
  let best = null;
  let bestArea = Infinity;
  for (const node of document.querySelectorAll(selector)) {
    if (node.classList.contains('is-dragging')) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const area = rect.width * rect.height;
    if (area < bestArea) {
      best = { node, rect };
      bestArea = area;
    }
  }
  return best;
}

function updateRequestDrop(x, y) {
  clearRequestDropMarkers();
  requestDrag.drop = null;
  const dragged = requestDrag.el.getBoundingClientRect();
  if (x >= dragged.left && x <= dragged.right && y >= dragged.top && y <= dragged.bottom) return;
  const row = smallestRowHit('#side-list .request-item, #side-list .folder-head', x, y);
  if (row?.node.classList.contains('request-item')) {
    const before = y < row.rect.top + row.rect.height / 2;
    row.node.classList.add(before ? 'is-drop-before' : 'is-drop-after');
    requestDrag.drop = {
      collectionId: row.node.dataset.collectionId,
      parentFolderId: row.node.dataset.parentFolderId || '',
      index: before ? Number(row.node.dataset.index) : Number(row.node.dataset.index) + 1,
    };
    return;
  }
  if (row?.node.classList.contains('folder-head')) {
    const ratio = (y - row.rect.top) / Math.max(row.rect.height, 1);
    const node = row.node;
    if (ratio < 0.28) {
      node.classList.add('is-drop-before');
      requestDrag.drop = {
        collectionId: node.dataset.collectionId,
        parentFolderId: node.dataset.parentFolderId || '',
        index: Number(node.dataset.index),
      };
    } else if (ratio > 0.72) {
      node.classList.add('is-drop-after');
      requestDrag.drop = {
        collectionId: node.dataset.collectionId,
        parentFolderId: node.dataset.parentFolderId || '',
        index: Number(node.dataset.index) + 1,
      };
    } else {
      node.classList.add('is-drop-into');
      const folder = findFolder(findCollection(node.dataset.collectionId), node.dataset.folderId);
      requestDrag.drop = {
        collectionId: node.dataset.collectionId,
        parentFolderId: node.dataset.folderId,
        index: (folder?.items || []).length,
      };
    }
    return;
  }
  const zone = smallestRowHit('#side-list .folder-body, #side-list .collection-body, #side-list .collection-head', x, y);
  if (!zone) return;
  if (zone.node.classList.contains('collection-head')) {
    const collectionId = zone.node.closest('.collection')?.dataset.collectionId;
    const collection = findCollection(collectionId);
    if (!collection) return;
    zone.node.classList.add('is-drop-into');
    requestDrag.drop = {
      collectionId,
      parentFolderId: '',
      index: (collection.items || []).length,
    };
    return;
  }
  zone.node.classList.add('is-drop-into');
  requestDrag.drop = {
    collectionId: zone.node.dataset.collectionId,
    parentFolderId: zone.node.dataset.dropParent || '',
    index: Number(zone.node.dataset.dropIndex || 0),
  };
}

function onRequestPointerEnd(event) {
  finishRequestDrag(event, event.type === 'pointercancel');
}

function finishRequestDrag(event, restore) {
  if (!requestDrag) return;
  if (event && event.pointerId !== requestDrag.pointerId) return;
  const session = requestDrag;
  requestDrag = null;
  window.removeEventListener('pointermove', onRequestPointerMove);
  window.removeEventListener('pointerup', onRequestPointerEnd);
  window.removeEventListener('pointercancel', onRequestPointerEnd);
  cancelAnimationFrame(session.scrollFrame);
  clearRequestDropMarkers();
  session.el.classList.remove('is-dragging');
  document.body.classList.remove('is-request-dragging');
  const moved = !restore && session.moved && session.drop
    ? moveRequest(session.collectionId, session.requestId, session.drop)
    : false;
  if (session.moved) {
    const swallow = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      document.removeEventListener('click', swallow, true);
    };
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 0);
  }
  if (moved || sideListNeedRender) {
    sideListNeedRender = false;
    renderSidebarList();
    if (moved) paintCrumb();
  }
}

function bindEvents() {
  document.querySelectorAll('[data-side]').forEach((button) => {
    button.addEventListener('click', () => {
      ui.side = button.dataset.side;
      paintSideSwitch();
      renderSidebarList();
    });
  });
  document.getElementById('side-primary').addEventListener('click', () => {
    if (ui.side === 'collections') {
      addCollection('New collection', { edit: true });
      renderSidebarList();
    } else if (ui.side === 'environments') createEnvironment('New environment', [], { edit: true });
    else if (confirm('Clear request history?')) {
      state.history = [];
      renderSidebarList();
      scheduleSave();
    }
  });
  document.getElementById('side-secondary').addEventListener('click', () => {
    if (ui.side === 'collections') newRequest();
  });
  document.getElementById('side-search').addEventListener('input', (event) => {
    ui.search = event.target.value;
    renderSidebarList();
  });
  const sideList = document.getElementById('side-list');
  sideList.addEventListener('pointerdown', onRequestPointerDown);
  sideList.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
      handleSideAction(action);
      return;
    }
    if (event.target.closest('input, textarea, select')) return;
    const request = event.target.closest('[data-request-id]');
    if (request) {
      openRequestTab(request.dataset.collectionId, request.dataset.requestId);
      return;
    }
    const history = event.target.closest('[data-history-id]');
    if (history) {
      loadHistory(history.dataset.historyId);
      return;
    }
    const envCard = event.target.closest('[data-env-id]');
    if (envCard?.dataset.envId) openEnvironmentTab(envCard.dataset.envId);
  });
  sideList.addEventListener('input', onSideInput);
  sideList.addEventListener('change', onSideInput);
  sideList.addEventListener('focusout', commitEditing);
  sideList.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.dataset?.field) {
      event.preventDefault();
      event.target.blur();
    }
  });
  document.getElementById('env-select').addEventListener('change', (event) => {
    state.activeEnvironmentId = event.target.value || null;
    if (ui.side === 'environments') renderSidebarList();
    paintEnvUse();
    refreshDerived();
  });
  document.getElementById('save-btn').addEventListener('click', saveInPlace);
  document.getElementById('save-as-btn').addEventListener('click', openSaveModal);
  document.getElementById('copy-curl').addEventListener('click', copyCurl);
  document.getElementById('request-name').addEventListener('input', (event) => {
    if (!state.draft) return;
    state.draft.name = event.target.value;
    paintCrumb();
    paintSave();
    renderDocTabs();
    renderStatus();
    scheduleSave();
  });
  document.getElementById('method').addEventListener('change', (event) => {
    state.draft.method = event.target.value;
    paintMethod();
    refreshDerived();
  });
  document.getElementById('url').addEventListener('input', onUrlInput);
  document.getElementById('url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendCurrent();
    }
  });
  document.getElementById('req-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    ui.reqTab = tab.dataset.tab;
    const current = activeRequestTab();
    if (current) current.reqTab = ui.reqTab;
    paintTabs();
    renderReqPanel();
  });
  const panel = document.getElementById('req-panel');
  panel.addEventListener('input', onTableEvent);
  panel.addEventListener('change', onTableEvent);
  panel.addEventListener('click', onPanelClick);
  document.getElementById('res-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-res]');
    if (!tab) return;
    ui.resTab = tab.dataset.res;
    renderResponse();
  });
  document.getElementById('res-toolbar').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'body-view') {
      ui.bodyView = action.dataset.view;
      renderResponse();
    } else if (action.dataset.action === 'copy-response') copyResponse();
    else if (action.dataset.action === 'save-response') saveResponse();
  });
  document.getElementById('send-btn').addEventListener('click', () => sendCurrent());
  const envPane = document.getElementById('env-pane');
  envPane.addEventListener('input', onSideInput);
  envPane.addEventListener('change', onSideInput);
  envPane.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) handleSideAction(action);
  });
  document.getElementById('env-tab-use').addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || tab.kind !== 'environment') return;
    state.activeEnvironmentId = tab.envId;
    refreshEnvSelect();
    if (ui.side === 'environments') renderSidebarList();
    paintEnvUse();
    refreshDerived();
  });
  const docTabs = document.getElementById('doc-tabs');
  docTabs.addEventListener('pointerdown', onTabPointerDown);
  docTabs.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-tab]');
    if (close) {
      closeTab(close.dataset.closeTab);
      return;
    }
    if (event.target.closest('[data-action="new-request-tab"]')) {
      newRequest();
      return;
    }
    const tab = event.target.closest('[data-doc-tab]');
    if (tab) activateTab(tab.dataset.docTab);
  });
  docTabs.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  docTabs.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const tab = event.target.closest('[data-doc-tab]');
    if (!tab) return;
    event.preventDefault();
    closeTab(tab.dataset.docTab);
  });
  document.getElementById('beautify-open').addEventListener('click', openBeautifier);
  document.getElementById('import-btn').addEventListener('click', onImport);
  document.getElementById('export-btn').addEventListener('click', onExport);
  const splitter = document.getElementById('splitter');
  const requestPane = document.getElementById('request-pane');
  splitter.addEventListener('mousedown', (event) => {
    const startY = event.clientY;
    const startHeight = requestPane.getBoundingClientRect().height;
    const main = document.querySelector('.main');
    const move = (moveEvent) => {
      const next = Math.max(180, Math.min(main.clientHeight - 160, startHeight + (moveEvent.clientY - startY)));
      requestPane.style.flexBasis = `${next}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  splitter.addEventListener('dblclick', () => { requestPane.style.flexBasis = '48%'; });
  document.addEventListener('keydown', (event) => {
    const typing = event.target.matches('input, textarea, select');
    if (event.key === 'Escape' && requestDrag) {
      event.preventDefault();
      finishRequestDrag(null, true);
      return;
    }
    if (event.key === 'Escape' && tabDrag) {
      event.preventDefault();
      finishTabDrag(null, true);
      return;
    }
    if (event.key === 'Escape' && document.getElementById('modal-back')) closeModal();
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendCurrent();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveInPlace();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') {
      event.preventDefault();
      if (!document.getElementById('modal-back') && state.activeTabId) closeTab(state.activeTabId);
    }
    if (event.ctrlKey && event.key === 'Tab' && state.tabs.length > 1 && !document.getElementById('modal-back')) {
      event.preventDefault();
      const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      const direction = event.shiftKey ? -1 : 1;
      const next = state.tabs[(index + direction + state.tabs.length) % state.tabs.length];
      if (next) activateTab(next.id);
    }
    if (!typing && event.key === '/' ) {
      event.preventDefault();
      document.getElementById('side-search').focus();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (!ui.persist) return;
    try { window.relay.saveSync(workspacePayload()); } catch { /* the debounced save already covers most edits */ }
  });
}

window.__relay = {
  get ready() { return ui.ready; },
  get bootError() { return ui.bootError; },
  send: () => sendCurrent(),
  createEnvironment: (name, variables) => createEnvironment(name, variables),
  workspace: () => workspacePayload(),
  apply: (data) => {
    applyWorkspace(data);
    renderAll();
  },
  snapshot: () => ({
    collections: state.collections.map((collection) => ({
      name: collection.name,
      requests: flatRequests(collection).map((request) => request.name),
    })),
    environments: state.environments.map((env) => env.name),
    active: activeEnvironment()?.name || null,
    history: state.history.length,
    dirty: isDirty(),
  }),
};

async function boot() {
  if (!window.relay) {
    document.body.textContent = 'Relay opens in its desktop window. From the project folder, run npm start.';
    return;
  }
  bindEvents();
  try {
    const loaded = await window.relay.load();
    if (!loaded?.ok && loaded?.error) throw new Error(loaded.error);
    applyWorkspace(loaded?.data || RelayCore.createSampleWorkspace());
    renderAll();
    ui.persist = true;
    if (!loaded?.data) await persistNow();
    if (loaded?.warning) flash(loaded.warning, 'error');
    ui.ready = true;
  } catch (err) {
    ui.bootError = err.stack || err.message;
    document.body.textContent = ui.bootError;
  }
}

boot();
