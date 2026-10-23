const state = {
  globals: { variables: [] },
  environments: [],
  activeEnvironmentId: null,
  collections: [],
  history: [],
  draft: null,
  loaded: null,
};

const ui = {
  side: 'collections',
  reqTab: 'params',
  resTab: 'body',
  bodyView: 'pretty',
  search: '',
  collapsed: new Set(),
  openEnvId: null,
  editing: null,
  response: null,
  sending: false,
  inflightId: null,
  sendGeneration: 0,
  savedSignature: '',
  statusMessage: '',
  statusKind: '',
  persist: false,
  ready: false,
  bootError: '',
};

let flashTimer = 0;

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
  return findCollection(collectionId)?.requests.find((request) => request.id === requestId) || null;
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

function isDirty() {
  if (!state.draft) return false;
  return signatureOf(state.draft) !== ui.savedSignature;
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

function workspacePayload() {
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
      requests: collection.requests.map((request) => ({
        id: request.id,
        ...RelayCore.normalizeRequest(request),
      })),
    })),
    history: state.history.slice(0, 50),
    draft: RelayCore.normalizeRequest(state.draft),
    loaded: state.loaded,
  };
}

function scheduleSave() {
  if (!ui.persist) return;
  clearTimeout(scheduleSave.timer);
  scheduleSave.timer = setTimeout(() => persistNow(), 400);
}

async function persistNow() {
  if (!ui.persist || !state.draft) return;
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
  state.draft = RelayCore.hydrateDraft(clean.draft || RelayCore.createEmptyDraft());
  state.loaded = clean.loaded;
  if (state.loaded && !findRequest(state.loaded.collectionId, state.loaded.requestId)) state.loaded = null;
  RelayCore.ensureVarTrailing(state.globals.variables);
  for (const env of state.environments) RelayCore.ensureVarTrailing(env.variables);
  ui.savedSignature = signatureOf(state.draft);
  ui.openEnvId = state.activeEnvironmentId;
}

function confirmDiscard() {
  if (!isDirty()) return true;
  return confirm('This request has unsaved changes. Discard them?');
}

function refreshDerived() {
  const built = currentBuilt();
  updateResolved(built);
  updateGenerated(built);
  updateCurlPreview(built);
  updateCounts();
  paintCrumb();
  paintSave();
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
  crumb.textContent = collection
    ? `${collection.name}  /  ${state.draft.name || 'Untitled request'}`
    : (state.draft.name || 'Untitled request');
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
  renderEditor();
}

function renderEditor() {
  document.getElementById('request-name').value = state.draft.name;
  document.getElementById('method').value = state.draft.method;
  document.getElementById('url').value = state.draft.url;
  paintMethod();
  paintTabs();
  renderReqPanel();
  renderResponse();
  refreshDerived();
  document.title = `${state.draft.name || 'Untitled request'} — Relay`;
}

function renderSidebarList() {
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
    const nameMatch = matches(query, collection.name);
    const requests = collection.requests.filter((request) => (
      nameMatch || matches(query, request.name, request.method, request.url)
    ));
    if (!nameMatch && requests.length === 0) continue;
    shown += 1;
    const visibleRequests = nameMatch && !query.trim() ? collection.requests : (nameMatch ? collection.requests : requests);
    const collapsed = ui.collapsed.has(collection.id) && !query.trim();
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
      el('span', { class: 'collection-count', text: String(collection.requests.length) }),
      el('span', { class: 'row-actions' },
        el('button', { class: 'icon-btn', text: '+', title: 'New request in this collection', 'data-action': 'add-request', 'data-collection-id': collection.id }),
        el('button', { class: 'icon-btn', text: '✎', title: 'Rename', 'data-action': 'rename-collection', 'data-collection-id': collection.id }),
        el('button', { class: 'icon-btn', text: '⧉', title: 'Duplicate', 'data-action': 'duplicate-collection', 'data-collection-id': collection.id }),
        el('button', { class: 'icon-btn danger', text: '✕', title: 'Delete', 'data-action': 'delete-collection', 'data-collection-id': collection.id }),
      ),
    );
    const block = el('section', { class: 'collection' }, head);
    if (!collapsed) {
      const rows = nameMatch ? collection.requests : visibleRequests;
      for (const request of rows) block.append(renderRequestRow(collection, request));
      if (!rows.length) block.append(el('div', { class: 'hint', text: 'No requests yet.' }));
    }
    wrap.append(block);
  }
  if (!shown) {
    wrap.append(el('div', { class: 'empty-state' },
      el('h3', { text: state.collections.length ? 'No matches' : 'No collections yet' }),
      el('p', { text: 'Save a request into a collection, or import a Postman collection.' }),
    ));
  }
  return wrap;
}

function renderRequestRow(collection, request) {
  const active = state.loaded?.collectionId === collection.id && state.loaded?.requestId === request.id;
  const editing = ui.editing?.kind === 'request' && ui.editing.id === request.id;
  return el('div', {
    class: `request-item${active ? ' is-active' : ''}`,
    'data-request-id': request.id,
    'data-collection-id': collection.id,
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
  const envs = state.environments.filter((env) => (
    matches(query, env.name, ...env.variables.map((variable) => `${variable.key} ${variable.value}`))
  ));
  if (!envs.length) wrap.append(el('div', { class: 'empty-state' }, el('h3', { text: 'No environments' })));
  for (const env of envs) wrap.append(renderEnvCard(env));
  return wrap;
}

function renderEnvCard(env) {
  const open = ui.openEnvId === env.id;
  const active = env.id === state.activeEnvironmentId;
  const editing = ui.editing?.kind === 'environment' && ui.editing.id === env.id;
  return el('section', { class: `env-card${active ? ' is-active' : ''}` },
    el('div', { class: 'env-head' },
      el('button', { class: 'icon-btn', text: open ? '▾' : '▸', title: 'Expand', 'data-action': 'toggle-env', 'data-env-id': env.id }),
      editing
        ? el('input', { class: 'rename-input', 'data-field': 'env-name', 'data-env-id': env.id, 'data-autofocus': 'true', value: env.name, spellcheck: 'false' })
        : el('span', { class: 'env-name', text: env.name }),
      el('button', { class: 'text-btn', text: active ? 'In use' : 'Use', 'data-action': 'use-env', 'data-env-id': env.id }),
      el('span', { class: 'row-actions' },
        el('button', { class: 'icon-btn', text: '✎', title: 'Rename', 'data-action': 'rename-env', 'data-env-id': env.id }),
        el('button', { class: 'icon-btn', text: '⧉', title: 'Duplicate', 'data-action': 'duplicate-env', 'data-env-id': env.id }),
        el('button', { class: 'icon-btn danger', text: '✕', title: 'Delete', 'data-action': 'delete-env', 'data-env-id': env.id }),
      ),
    ),
    open ? renderVarTable(env.variables, 'env', env.id) : null,
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

function loadDraft(draft, loaded, response) {
  state.draft = RelayCore.hydrateDraft(draft);
  state.loaded = loaded;
  ui.response = response;
  ui.savedSignature = signatureOf(state.draft);
  renderEditor();
  renderSidebarList();
}

function loadRequest(collectionId, requestId) {
  if (state.loaded?.collectionId === collectionId && state.loaded?.requestId === requestId) return;
  if (!confirmDiscard()) return;
  const request = findRequest(collectionId, requestId);
  if (!request) return;
  loadDraft(request, { collectionId, requestId }, null);
}

function newRequest() {
  if (!confirmDiscard()) return;
  loadDraft(RelayCore.createEmptyDraft(), null, null);
  scheduleSave();
}

function addBlankRequest(collectionId) {
  if (!confirmDiscard()) return;
  const collection = findCollection(collectionId);
  if (!collection) return;
  const request = { id: RelayCore.newId(), ...RelayCore.normalizeRequest({ ...RelayCore.createEmptyDraft(), name: 'New request' }) };
  collection.requests.push(request);
  loadDraft(request, { collectionId, requestId: request.id }, null);
}

function addCollection(name, { edit = false } = {}) {
  const collection = { id: RelayCore.newId(), name: name || 'New collection', requests: [] };
  state.collections.push(collection);
  if (edit) ui.editing = { kind: 'collection', id: collection.id };
  scheduleSave();
  return collection;
}

function saveInPlace() {
  if (!state.loaded) {
    openSaveModal();
    return;
  }
  const collection = findCollection(state.loaded.collectionId);
  const request = collection?.requests.find((item) => item.id === state.loaded.requestId);
  if (!collection || !request) {
    state.loaded = null;
    openSaveModal();
    return;
  }
  const normalized = RelayCore.normalizeRequest(state.draft);
  const id = request.id;
  Object.keys(request).forEach((key) => { if (key !== 'id') delete request[key]; });
  Object.assign(request, normalized, { id });
  ui.savedSignature = signatureOf(state.draft);
  renderSidebarList();
  refreshDerived();
  flash('Saved.');
}

function openSaveModal() {
  const name = el('input', { id: 'modal-request-name', 'data-testid': 'modal-request-name', value: state.draft.name || 'Untitled request', spellcheck: 'false' });
  const select = el('select', { id: 'modal-collection', 'data-testid': 'modal-collection' });
  for (const collection of state.collections) select.append(new Option(collection.name, collection.id));
  if (state.loaded?.collectionId) select.value = state.loaded.collectionId;
  const created = el('input', { id: 'modal-new-collection', 'data-testid': 'modal-new-collection', placeholder: 'New collection name', spellcheck: 'false' });
  const error = el('p', { class: 'form-error' });
  openModal({
    title: 'Save request',
    body: el('div', {},
      field('Request name', name),
      state.collections.length ? field('Collection', select) : null,
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
      state.draft.name = requestName;
      document.getElementById('request-name').value = requestName;
      const request = { id: RelayCore.newId(), ...RelayCore.normalizeRequest(state.draft) };
      collection.requests.push(request);
      state.loaded = { collectionId: collection.id, requestId: request.id };
      ui.savedSignature = signatureOf(state.draft);
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
  const request = collection?.requests.find((item) => item.id === requestId);
  if (!request) return;
  const index = collection.requests.indexOf(request);
  const copy = withFreshRowIds(RelayCore.normalizeRequest(request));
  copy.name = `${request.name} copy`;
  collection.requests.splice(index + 1, 0, { id: RelayCore.newId(), ...copy });
  renderSidebarList();
  scheduleSave();
}

function deleteRequest(collectionId, requestId) {
  const collection = findCollection(collectionId);
  const request = collection?.requests.find((item) => item.id === requestId);
  if (!request) return;
  if (!confirm(`Delete “${request.name}”?`)) return;
  collection.requests = collection.requests.filter((item) => item.id !== requestId);
  if (state.loaded?.collectionId === collectionId && state.loaded?.requestId === requestId) {
    loadDraft(RelayCore.createEmptyDraft(), null, null);
  } else renderSidebarList();
  scheduleSave();
}

function deleteCollection(id) {
  const collection = findCollection(id);
  if (!collection || !confirm(`Delete “${collection.name}” and its requests?`)) return;
  state.collections = state.collections.filter((item) => item.id !== id);
  if (state.loaded?.collectionId === id) loadDraft(RelayCore.createEmptyDraft(), null, null);
  else renderSidebarList();
  scheduleSave();
}

function duplicateCollection(id) {
  const collection = findCollection(id);
  if (!collection) return;
  state.collections.push({
    id: RelayCore.newId(),
    name: `${collection.name} copy`,
    requests: collection.requests.map((request) => ({
      id: RelayCore.newId(),
      ...withFreshRowIds(RelayCore.normalizeRequest(request)),
    })),
  });
  renderSidebarList();
  scheduleSave();
}

function createEnvironment(name, variables, { edit = false, activate = true } = {}) {
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
  ui.openEnvId = env.id;
  if (edit) ui.editing = { kind: 'environment', id: env.id };
  refreshEnvSelect();
  if (ui.side === 'environments') renderSidebarList();
  refreshDerived();
  return env.id;
}

function duplicateEnvironment(id) {
  const env = findEnvironment(id);
  if (!env) return;
  createEnvironment(`${env.name} copy`, RelayCore.stripVars(env.variables), { activate: false });
  renderSidebarList();
}

function deleteEnvironment(id) {
  const env = findEnvironment(id);
  if (!env || !confirm(`Delete environment “${env.name}”?`)) return;
  state.environments = state.environments.filter((item) => item.id !== id);
  if (state.activeEnvironmentId === id) state.activeEnvironmentId = null;
  if (ui.openEnvId === id) ui.openEnvId = state.activeEnvironmentId;
  refreshEnvSelect();
  renderSidebarList();
  refreshDerived();
}

function loadHistory(id) {
  const item = state.history.find((entry) => entry.id === id);
  if (!item?.draft || !confirmDiscard()) return;
  loadDraft(item.draft, null, null);
}

function pushHistory(built, result) {
  const snapshot = RelayCore.normalizeRequest(state.draft);
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
  if (ui.sending) {
    await window.relay.cancel(ui.inflightId);
    return { error: 'Cancelled', cancelled: true };
  }
  const built = currentBuilt();
  refreshDerived();
  if (!built.ok) {
    ui.response = { error: built.error, warnings: built.warnings, missing: built.missing };
    renderResponse();
    return ui.response;
  }
  if (built.missing.length) {
    const proceed = confirm(`These variables are not defined: ${built.missing.join(', ')}.\n\nSend the request anyway?`);
    if (!proceed) return { error: 'Cancelled', cancelled: true };
  }
  const generation = ++ui.sendGeneration;
  ui.sending = true;
  ui.inflightId = RelayCore.newId();
  paintSendButton();
  renderStatus();
  try {
    const result = await window.relay.send({ requestId: ui.inflightId, ...built.request });
    if (generation !== ui.sendGeneration) return result;
    ui.response = {
      ...result,
      warnings: [...built.warnings, ...(result?.warnings || [])],
      missing: built.missing,
      requestUrl: built.request.url,
    };
    if (!result?.cancelled) pushHistory(built, result || {});
    renderResponse();
    if (ui.side === 'history') renderSidebarList();
    scheduleSave();
    return ui.response;
  } finally {
    if (generation === ui.sendGeneration) {
      ui.sending = false;
      ui.inflightId = null;
      paintSendButton();
      renderStatus();
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
      ...collection,
      id: RelayCore.newId(),
      requests: collection.requests.map((request) => ({ ...request, id: RelayCore.newId() })),
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
    state.collections.push(imported.collection);
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
    ui.openEnvId = imported.environment.id;
    ui.side = 'environments';
    paintSideSwitch();
    refreshEnvSelect();
    renderSidebarList();
    refreshDerived();
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
      addBlankRequest(collectionId);
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
    case 'toggle-env':
      ui.openEnvId = ui.openEnvId === envId ? null : envId;
      renderSidebarList();
      break;
    case 'use-env':
      state.activeEnvironmentId = envId;
      ui.openEnvId = envId;
      refreshEnvSelect();
      renderSidebarList();
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
  if (field === 'request-name') {
    const request = findRequest(target.dataset.collectionId, target.dataset.requestId);
    if (request) request.name = target.value;
    if (state.loaded?.requestId === target.dataset.requestId) {
      state.draft.name = target.value;
      document.getElementById('request-name').value = target.value;
      paintCrumb();
    }
    scheduleSave();
    return;
  }
  if (field === 'env-name') {
    const env = findEnvironment(target.dataset.envId);
    if (env) env.name = target.value;
    refreshEnvSelect();
    scheduleSave();
    renderStatus();
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
  if (!ui.editing || !['collection-name', 'request-name', 'env-name'].includes(field)) return;
  setTimeout(() => {
    if (!ui.editing) return;
    ui.editing = null;
    renderSidebarList();
  }, 0);
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
  sideList.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
      handleSideAction(action);
      return;
    }
    if (event.target.closest('input, textarea, select')) return;
    const request = event.target.closest('[data-request-id]');
    if (request) {
      loadRequest(request.dataset.collectionId, request.dataset.requestId);
      return;
    }
    const history = event.target.closest('[data-history-id]');
    if (history) loadHistory(history.dataset.historyId);
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
    ui.openEnvId = state.activeEnvironmentId;
    if (ui.side === 'environments') renderSidebarList();
    refreshDerived();
  });
  document.getElementById('save-btn').addEventListener('click', saveInPlace);
  document.getElementById('save-as-btn').addEventListener('click', openSaveModal);
  document.getElementById('copy-curl').addEventListener('click', copyCurl);
  document.getElementById('request-name').addEventListener('input', (event) => {
    state.draft.name = event.target.value;
    document.title = `${state.draft.name || 'Untitled request'} — Relay`;
    paintCrumb();
    paintSave();
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
    if (event.key === 'Escape' && document.getElementById('modal-back')) closeModal();
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      sendCurrent();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveInPlace();
    }
    if (!typing && event.key === '/' ) {
      event.preventDefault();
      document.getElementById('side-search').focus();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (!ui.persist || !state.draft) return;
    try { window.relay.saveSync(workspacePayload()); } catch { /* the debounced save already covers most edits */ }
  });
}

window.__relay = {
  get ready() { return ui.ready; },
  get bootError() { return ui.bootError; },
  send: () => sendCurrent(),
  createEnvironment: (name, variables) => createEnvironment(name, variables),
  snapshot: () => ({
    collections: state.collections.map((collection) => ({
      name: collection.name,
      requests: collection.requests.map((request) => request.name),
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
