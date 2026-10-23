const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const debugPort = 9333;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-'));

function stop(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('Could not connect to the Relay window.')));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const done = pending.get(message.id);
      pending.delete(message.id);
      done(message);
    }
  });
  return {
    ready,
    send(method, params = {}, timeout = 20000) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
        pending.set(id, (message) => {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, awaitPromise ? 40000 : 10000);
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error(details.exception?.description || details.text || 'The page threw an error.');
  }
  return result.result?.value;
}

function exercise(base) {
  return `(async () => {
    const $ = (sel) => {
      const node = document.querySelector(sel);
      if (!node) throw new Error('Missing ' + sel);
      return node;
    };
    const click = (sel) => $(sel).click();
    const set = (node, value) => {
      node.focus();
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const check = (cond, message) => { if (!cond) throw new Error(message); };
    const base = ${JSON.stringify(base)};

    check(document.querySelector('[data-request-name="Get post"]'), 'sample request missing');
    check($('#resolved').textContent.includes('jsonplaceholder.typicode.com/posts/1'), $('#resolved').textContent);
    click('[data-testid="tab-curl"]');
    const curlText = $('[data-testid="curl-command"]').textContent;
    check(curlText.includes('curl.exe -X GET'), curlText);
    check(curlText.includes('https://jsonplaceholder.typicode.com/posts/1'), curlText);
    set($('#url'), '{{baseUrl}}/posts/{{missing}}');
    check($('[data-testid="curl-command"]').textContent.includes('{{missing}}'), $('[data-testid="curl-command"]').textContent);
    check($('[data-testid="curl-note"]').textContent.includes('missing'), $('[data-testid="curl-note"]').textContent);
    set($('#url'), '{{baseUrl}}/posts/1');

    set($('#method'), 'POST');
    set($('#url'), base + '/echo?q=1');
    set($('#request-name'), 'Echo check');
    click('[data-testid="tab-headers"]');
    const headerRow = $('[data-list="headers"] .kv-row:last-child');
    set(headerRow.querySelector('[data-field="key"]'), 'X-Test');
    set(headerRow.querySelector('[data-field="value"]'), 'relay');
    click('[data-testid="tab-body"]');
    click('[data-testid="body-mode-raw"]');
    set($('#raw-type'), 'json');
    set($('#raw-body'), '{"hello":"world"}');
    click('[data-testid="tab-auth"]');
    set($('#auth-type'), 'bearer');
    set($('#bearer-token'), 'tok-123');
    let result = await window.__relay.send();
    check(!result.error, result.error || 'send failed');
    check(result.status === 200, 'status ' + result.status);
    let echoed = JSON.parse(result.bodyText);
    check(echoed.method === 'POST', 'method ' + echoed.method);
    check(echoed.query.q === '1', 'query ' + JSON.stringify(echoed.query));
    check(echoed.headers['x-test'] === 'relay', 'header ' + echoed.headers['x-test']);
    check(echoed.headers.authorization === 'Bearer tok-123', 'auth ' + echoed.headers.authorization);
    check(echoed.body === '{"hello":"world"}', 'body ' + echoed.body);
    check(/application\\/json/i.test(echoed.headers['content-type'] || ''), 'content-type ' + echoed.headers['content-type']);
    check($('[data-testid="response"]').textContent.includes('hello'), 'response panel missing body');
    check($('[data-testid="response-meta"]').textContent.includes('200'), 'status missing from the panel');

    window.__relay.createEnvironment('Local', [{ key: 'baseUrl', value: base }]);
    check([...$('#env-select').options].some((option) => option.textContent === 'Local'), 'environment missing');
    check($('#env-select').selectedOptions[0].textContent === 'Local', 'environment not active');
    check(document.querySelector('[data-doc-tab][data-kind="environment"]'), 'new environment did not open a tab');
    const requestTab = document.querySelector('[data-doc-tab][data-kind="request"]');
    check(requestTab, 'request tab missing');
    requestTab.click();
    set($('#method'), 'GET');
    set($('#url'), '{{baseUrl}}/echo?item=book');
    click('[data-testid="tab-body"]');
    click('[data-testid="body-mode-none"]');
    click('[data-testid="tab-auth"]');
    set($('#auth-type'), 'none');
    check($('#resolved').textContent.includes(base + '/echo?item=book'), $('#resolved').textContent);
    result = await window.__relay.send();
    check(!result.error, result.error || 'environment send failed');
    echoed = JSON.parse(result.bodyText);
    check(echoed.method === 'GET', echoed.method);
    check(echoed.query.item === 'book', JSON.stringify(echoed.query));
    check(!echoed.headers.authorization, 'authorization leaked: ' + echoed.headers.authorization);

    set($('#url'), '{{baseUrl}}/redirect');
    result = await window.__relay.send();
    check(!result.error, result.error || 'redirect failed');
    check(result.status === 200, 'redirect status ' + result.status);
    check(result.redirectCount >= 1, 'redirect was not followed');
    echoed = JSON.parse(result.bodyText);
    check(echoed.query.item === 'book', 'redirect landed on ' + echoed.url);

    set($('#method'), 'POST');
    set($('#url'), base + '/echo');
    click('[data-testid="tab-body"]');
    click('[data-testid="body-mode-urlencoded"]');
    const formRow = $('[data-list="urlencoded"] .kv-row:last-child');
    set(formRow.querySelector('[data-field="key"]'), 'note');
    set(formRow.querySelector('[data-field="value"]'), 'hi');
    result = await window.__relay.send();
    check(!result.error, result.error || 'form send failed');
    echoed = JSON.parse(result.bodyText);
    check(echoed.body === 'note=hi', echoed.body);
    check(/urlencoded/i.test(echoed.headers['content-type'] || ''), echoed.headers['content-type']);

    set($('#url'), '{{missingVar}}/echo');
    check($('#resolved').textContent.includes('missingVar'), $('#resolved').textContent);

    click('[data-testid="beautify-open"]');
    set($('[data-testid="beautify-input"]'), '{"a":1}');
    click('[data-testid="beautify-run"]');
    check($('[data-testid="beautify-output"]').textContent.includes('"a"'), 'beautifier produced no output');
    set($('[data-testid="beautify-input"]'), '{');
    click('[data-testid="beautify-run"]');
    check($('[data-testid="beautify-error"]').textContent.length > 0, 'invalid JSON was accepted');
    click('[data-testid="modal-close"]');

    set($('#url'), base + '/echo');
    click('[data-testid="tab-body"]');
    click('[data-testid="body-mode-raw"]');
    set($('#raw-body'), '{"a":1}');
    click('[data-testid="beautify-body"]');
    check($('#raw-body').value.includes('\\n'), $('#raw-body').value);

    click('[data-testid="save-as-btn"]');
    set($('[data-testid="modal-request-name"]'), 'Echo check');
    set($('[data-testid="modal-new-collection"]'), 'Smoke collection');
    click('[data-testid="modal-confirm"]');
    check(document.querySelector('[data-request-name="Echo check"]'), 'saved request missing');
    check(document.querySelector('[data-collection-name="Smoke collection"]'), 'saved collection missing');
    const snap = window.__relay.snapshot();
    check(snap.history >= 3, 'history ' + snap.history);

    const getPost = $('[data-request-name="Get post"]');
    click('[data-request-name="Get post"]');
    check($('#doc-tabs [data-doc-tab].is-active').dataset.requestId === getPost.dataset.requestId, 'saved request did not become the active tab');
    const openCount = document.querySelectorAll('[data-doc-tab]').length;
    click('[data-request-name="Get post"]');
    check(document.querySelectorAll('[data-doc-tab]').length === openCount, 'the same request opened twice');
    click('#side-secondary');
    check(document.querySelectorAll('[data-doc-tab]').length === openCount + 1, 'new request did not open a tab');
    click('[data-side="environments"]');
    const envCount = document.querySelectorAll('[data-doc-tab][data-kind="environment"]').length;
    const local = [...document.querySelectorAll('.env-name')].find((node) => node.textContent === 'Local');
    check(local, 'Local environment missing from the sidebar');
    local.click();
    check(document.querySelectorAll('[data-doc-tab][data-kind="environment"]').length === envCount, 'environment opened twice');
    check($('#doc-tabs [data-doc-tab].is-active').dataset.kind === 'environment', 'environment tab is not active');
    const saved = window.__relay.workspace();
    check(saved.tabs.length === document.querySelectorAll('[data-doc-tab]').length, 'saved tab count ' + saved.tabs.length);
    check(saved.tabs.some((tab) => tab.kind === 'environment' && tab.envId), 'environment tab was not saved');
    check(saved.activeTabId === $('#doc-tabs [data-doc-tab].is-active').dataset.docTab, 'active tab was not saved');
    window.__relay.apply(saved);
    check(document.querySelectorAll('[data-doc-tab]').length === saved.tabs.length, 'tabs were not restored');
    check($('#doc-tabs [data-doc-tab].is-active').dataset.docTab === saved.activeTabId, 'active tab was not restored');
    return { ok: true, history: snap.history };
  })()`;
}

async function main() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/echo?item=book' });
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
      query: Object.fromEntries(url.searchParams.entries()),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronPath = require('electron');
  const child = spawn(electronPath, ['.', `--debug-port=${debugPort}`, `--user-data-dir=${dataDir}`], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  let client;
  try {
    let targets = [];
    for (let attempt = 0; attempt < 80 && !targets.length; attempt += 1) {
      if (child.exitCode != null) throw new Error(`Relay exited early.\n${logs.join('').slice(-4000)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const list = await response.json();
        targets = list.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      } catch {
        targets = [];
      }
      if (!targets.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!targets.length) throw new Error(`Relay did not open a debuggable window.\n${logs.join('').slice(-4000)}`);
    client = connect(targets[0].webSocketDebuggerUrl);
    await client.ready;
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
      try {
        ready = await evaluate(client, 'Boolean(window.__relay && window.__relay.ready)', false);
      } catch {
        ready = false;
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) {
      let bootError = '';
      try { bootError = await evaluate(client, 'window.__relay ? window.__relay.bootError : "app missing"', false); } catch { /* still starting */ }
      throw new Error(`Relay did not finish opening. ${bootError || ''}\n${logs.join('').slice(-4000)}`);
    }
    const report = await evaluate(client, exercise(base));
    if (!report?.ok) throw new Error(`Unexpected smoke result: ${JSON.stringify(report)}`);
    console.log(`Relay smoke passed (${report.history} history entries).`);
  } finally {
    if (client) client.close();
    stop(child);
    await new Promise((resolve) => {
      if (child.exitCode != null) resolve();
      else {
        child.once('exit', resolve);
        setTimeout(resolve, 4000);
      }
    });
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
