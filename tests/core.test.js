const test = require('node:test');
const assert = require('node:assert/strict');
const RelayCore = require('../src/core.js');

function draft(overrides) {
  return {
    ...RelayCore.createEmptyDraft(),
    auth: { ...RelayCore.createEmptyDraft().auth, ...(overrides.auth || {}) },
    ...overrides,
  };
}

test('cURL command includes the resolved request', () => {
  const built = RelayCore.buildOutgoing(draft({
    method: 'POST',
    url: 'https://example.com/items',
    headers: [{ key: 'X-Trace', value: '1', enabled: true }],
    bodyMode: 'raw',
    rawType: 'json',
    rawBody: '{"a":1}',
    authType: 'bearer',
    auth: { bearerToken: 'tok' },
    followRedirects: true,
    insecureTLS: true,
    timeoutMs: 5000,
  }), Object.create(null));
  const curl = RelayCore.toCurl(built);
  assert.match(curl, /^curl\.exe -X POST "https:\/\/example\.com\/items"/);
  assert.match(curl, /-L/);
  assert.match(curl, /--insecure/);
  assert.match(curl, /--max-time 5/);
  assert.match(curl, /-H "Authorization: Bearer tok"/);
  assert.match(curl, /-H "X-Trace: 1"/);
  assert.match(curl, /--data-raw "\{\\"a\\":1\}"/);
  assert.equal(RelayCore.toCurl({ request: { url: '' } }), '');
});

test('sample request resolves the active environment', () => {
  const workspace = RelayCore.createSampleWorkspace();
  const scope = RelayCore.buildScope(workspace.globals, workspace.environments[0]);
  const built = RelayCore.buildOutgoing(workspace.draft, scope);
  assert.equal(built.ok, true);
  assert.equal(built.request.url, 'https://jsonplaceholder.typicode.com/posts/1');
  assert.match(RelayCore.toCurl(built), /curl\.exe -X GET/);
});

test('active environment overrides globals and skips dangerous keys', () => {
  const scope = RelayCore.buildScope(
    { variables: [{ key: 'baseUrl', value: 'http://global', enabled: true }, { key: '__proto__', value: 'nope', enabled: true }] },
    { variables: [{ key: 'baseUrl', value: 'http://env', enabled: true }, { key: 'off', value: '1', enabled: false }] },
  );
  assert.equal(scope.baseUrl, 'http://env');
  assert.equal(Object.prototype.hasOwnProperty.call(scope, '__proto__'), false);
  assert.equal(RelayCore.interpolate('{{off}}', scope), '{{off}}');
  assert.equal(RelayCore.interpolate('{{url}}/items', { url: 'https://{{host}}/v1', host: 'example.com' }), 'https://example.com/v1/items');
});

test('dynamic variables are replaced and unknown names stay visible', () => {
  const first = RelayCore.interpolate('{{$guid}}', Object.create(null));
  const second = RelayCore.interpolate('{{$uuid}}', Object.create(null));
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f-]{36}$/i);
  const built = RelayCore.buildOutgoing(draft({ url: 'https://example.com/{{id}}' }), Object.create(null));
  assert.equal(built.ok, true);
  assert.deepEqual(built.missing, ['id']);
});

test('query params keep variable braces and disabled rows', () => {
  const url = RelayCore.applyParamsToUrl('https://example.com/search#top', [
    { key: 'q', value: '{{term}}', enabled: true },
    { key: 'skip', value: '1', enabled: false },
  ]);
  assert.equal(url, 'https://example.com/search?q={{term}}#top');
  const rows = RelayCore.syncParamsFromUrl('https://example.com?q=new', [
    { id: '1', key: 'q', value: 'old', description: 'search', enabled: true },
    { id: '2', key: 'debug', value: '1', description: 'keep', enabled: false },
  ]);
  assert.equal(rows[0].id, '1');
  assert.equal(rows[0].value, 'new');
  assert.equal(rows[0].description, 'search');
  assert.equal(rows[1].key, 'debug');
  assert.equal(rows[1].enabled, false);
});

test('auth, body, and headers are assembled for the wire', () => {
  const basic = RelayCore.buildOutgoing(draft({
    url: 'https://example.com/private',
    authType: 'basic',
    auth: { basicUser: 'user', basicPass: 'pass' },
  }), Object.create(null));
  assert.equal(basic.request.headers.find((header) => header.key === 'Authorization').value, 'Basic dXNlcjpwYXNz');
  assert.equal(RelayCore.encodeBasic('café', 'x'), Buffer.from('café:x').toString('base64'));

  const api = RelayCore.buildOutgoing(draft({
    url: 'https://example.com/items',
    authType: 'apikey',
    auth: { apiKey: 'token', apiValue: 'abc', apiIn: 'query' },
  }), Object.create(null));
  assert.equal(api.request.url, 'https://example.com/items?token=abc');

  const get = RelayCore.buildOutgoing(draft({
    url: 'https://example.com',
    bodyMode: 'raw',
    rawBody: '{}',
  }), Object.create(null));
  assert.equal(get.request.bodyText, null);
  assert.match(get.warnings[0], /without a body/);

  const form = RelayCore.buildOutgoing(draft({
    method: 'POST',
    url: 'https://example.com',
    bodyMode: 'urlencoded',
    urlencoded: [{ key: 'note', value: 'hi', enabled: true }],
  }), Object.create(null));
  assert.equal(form.request.bodyText, 'note=hi');
  assert.ok(form.request.headers.some((header) => header.value === 'application/x-www-form-urlencoded'));

  const bad = RelayCore.buildOutgoing(draft({
    url: 'https://example.com',
    headers: [{ key: 'Bad Name', value: 'x', enabled: true }],
  }), Object.create(null));
  assert.equal(bad.ok, false);
});

test('json tools escape html and format text', () => {
  assert.equal(RelayCore.beautifyJson('{"a":1}').text, '{\n  "a": 1\n}');
  assert.equal(RelayCore.minifyJson('{\n  "a": 1\n}').text, '{"a":1}');
  assert.equal(RelayCore.beautifyJson('{').ok, false);
  const html = RelayCore.highlightJson('{"a":"<script>"}');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('multipart body contains text and file parts', () => {
  const built = RelayCore.buildMultipart([
    { name: 'title', value: 'Hello' },
    { name: 'file', filename: 'note.txt', value: new TextEncoder().encode('abc') },
  ]);
  const text = new TextDecoder().decode(built.body);
  assert.match(built.contentType, /multipart\/form-data; boundary=----Relay/);
  assert.match(text, /name="title"/);
  assert.match(text, /Hello/);
  assert.match(text, /filename="note.txt"/);
  assert.match(text, /abc/);
});

test('Postman collections and environments import into Relay', () => {
  const imported = RelayCore.readImported({
    info: { name: 'Demo' },
    item: [{
      name: 'Users',
      item: [{
        name: 'List',
        request: {
          method: 'GET',
          header: [{ key: 'X-Trace', value: '1' }],
          url: { raw: '{{base}}/users?active=1', query: [{ key: 'active', value: '1' }] },
          auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
        },
      }],
    }],
  });
  assert.equal(imported.kind, 'postman-collection');
  assert.equal(imported.collection.name, 'Demo');
  assert.equal(imported.collection.requests[0].name, 'Users / List');
  assert.equal(imported.collection.requests[0].authType, 'bearer');
  assert.equal(imported.collection.requests[0].auth.bearerToken, '{{token}}');
  assert.match(imported.collection.requests[0].url, /active=1/);

  const environment = RelayCore.readImported({
    name: 'Dev',
    values: [{ key: 'baseUrl', value: 'http://localhost', enabled: true }],
  });
  assert.equal(environment.kind, 'postman-environment');
  assert.equal(environment.environment.variables[0].key, 'baseUrl');

  const workspace = RelayCore.createSampleWorkspace();
  assert.equal(RelayCore.detectImport(workspace), 'relay');
  assert.equal(RelayCore.sanitizeWorkspace({ ...workspace, activeEnvironmentId: 'missing' }).activeEnvironmentId, null);
});

test('open tabs are restored and broken links are dropped', () => {
  const legacy = RelayCore.sanitizeWorkspace({
    draft: { name: 'Legacy', method: 'POST', url: 'http://example.test/legacy' },
    loaded: null,
    collections: [],
    environments: [],
  });
  assert.equal(legacy.tabs.length, 1);
  assert.equal(legacy.tabs[0].kind, 'request');
  assert.equal(legacy.tabs[0].draft.name, 'Legacy');
  assert.equal(legacy.tabs[0].draft.method, 'POST');
  assert.equal(legacy.activeTabId, legacy.tabs[0].id);

  const clean = RelayCore.sanitizeWorkspace({
    activeTabId: 'missing-tab',
    tabs: [
      {
        id: 'tab-request',
        kind: 'request',
        reqTab: 'body',
        historyId: 'hist-1',
        draft: { name: 'Kept', method: 'PUT', url: 'http://example.test/kept' },
        loaded: { collectionId: 'col', requestId: 'req' },
      },
      { id: 'tab-env', kind: 'environment', envId: 'env-1' },
      { id: 'tab-gone', kind: 'environment', envId: 'missing' },
      {
        id: 'tab-unsaved',
        kind: 'request',
        draft: { name: 'Loose', method: 'GET', url: 'http://example.test/loose' },
        loaded: { collectionId: 'missing', requestId: 'missing' },
      },
    ],
    collections: [{
      id: 'col',
      name: 'Demo',
      requests: [{ id: 'req', name: 'Kept', method: 'GET', url: 'http://example.test/saved' }],
    }],
    environments: [{ id: 'env-1', name: 'Dev', variables: [] }],
  });
  assert.deepEqual(clean.tabs.map((tab) => tab.id), ['tab-request', 'tab-env', 'tab-unsaved']);
  assert.equal(clean.activeTabId, 'tab-request');
  assert.equal(clean.tabs[0].reqTab, 'body');
  assert.equal(clean.tabs[0].historyId, 'hist-1');
  assert.deepEqual(clean.tabs[0].loaded, { collectionId: 'col', requestId: 'req' });
  assert.equal(clean.tabs[0].draft.url, 'http://example.test/kept');
  assert.equal(clean.tabs[1].envId, 'env-1');
  assert.equal(clean.tabs[2].loaded, null);
  assert.equal(clean.draft.url, 'http://example.test/kept');

  const again = RelayCore.sanitizeWorkspace(clean);
  assert.deepEqual(again.tabs.map((tab) => tab.id), clean.tabs.map((tab) => tab.id));
  assert.equal(again.activeTabId, clean.activeTabId);

  const flat = RelayCore.sanitizeWorkspace({
    collections: [{
      id: 'col-legacy',
      name: 'Legacy',
      requests: [
        { id: 'req-a', name: 'Alpha', method: 'GET', url: 'http://example.test/a' },
        { id: 'req-b', name: 'Beta', method: 'POST', url: 'http://example.test/b' },
      ],
    }],
  });
  assert.deepEqual(flat.collections[0].items.map((item) => item.name), ['Alpha', 'Beta']);

  const nested = RelayCore.sanitizeWorkspace({
    collections: [{
      id: 'col',
      name: 'Demo',
      items: [
        { id: 'req-root', name: 'Root', method: 'GET', url: 'http://example.test/root' },
        {
          kind: 'folder',
          id: 'folder-1',
          name: 'Auth',
          items: [
            { id: 'req-login', name: 'Login', method: 'POST', url: 'http://example.test/login' },
            {
              kind: 'folder',
              id: 'folder-2',
              name: 'Nested',
              items: [{ id: 'req-deep', name: 'Deep', method: 'GET', url: 'http://example.test/deep' }],
            },
          ],
        },
      ],
    }],
    tabs: [{
      id: 'tab-deep',
      kind: 'request',
      draft: { name: 'Deep', method: 'GET', url: 'http://example.test/deep' },
      loaded: { collectionId: 'col', requestId: 'req-deep' },
    }],
  });
  assert.equal(nested.collections[0].items[1].name, 'Auth');
  assert.equal(nested.collections[0].items[1].items[1].items[0].name, 'Deep');
  assert.deepEqual(nested.tabs[0].loaded, { collectionId: 'col', requestId: 'req-deep' });
  const roundTrip = RelayCore.sanitizeWorkspace(nested);
  assert.equal(roundTrip.collections[0].items[1].items[0].id, 'req-login');
  assert.equal(roundTrip.tabs[0].loaded.requestId, 'req-deep');

  const closed = RelayCore.sanitizeWorkspace({ tabs: [], draft: { name: 'Ignored', url: 'http://example.test' }, collections: [], environments: [] });
  assert.deepEqual(closed.tabs, []);
  assert.equal(closed.activeTabId, null);
});
