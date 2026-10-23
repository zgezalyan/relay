const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const https = require('https');
const RelayCore = require('./src/core.js');

app.setName('Relay');

const debugArg = process.argv.find((arg) => arg.startsWith('--debug-port='));
if (debugArg) {
  app.commandLine.appendSwitch('remote-debugging-port', debugArg.split('=')[1]);
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}

const MAX_BODY = 8 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const inflight = new Map();

function workspaceFile() {
  return path.join(app.getPath('userData'), 'workspace.json');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#14181e',
    title: 'Relay',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function formatNetError(err) {
  const code = err.code || err.cause?.code;
  const known = {
    ENOTFOUND: 'Could not resolve that host',
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'The connection was reset',
    ETIMEDOUT: 'The connection timed out',
    EHOSTUNREACH: 'Host is unreachable',
    ENETUNREACH: 'Network is unreachable',
    CERT_HAS_EXPIRED: 'The TLS certificate has expired. Turn on “Accept invalid certificates” in Settings to allow it.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'The TLS certificate is self-signed. Turn on “Accept invalid certificates” in Settings to allow it.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'The TLS certificate could not be verified. Turn on “Accept invalid certificates” in Settings to allow it.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The TLS certificate does not match the host.',
  };
  if (code && known[code]) return `${known[code]} (${code})`;
  return err.message || 'Request failed';
}

function pairsFromRaw(rawHeaders) {
  const pairs = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    pairs.push({ key: rawHeaders[i], value: String(rawHeaders[i + 1] ?? '') });
  }
  return pairs;
}

function headerValue(pairs, name) {
  const found = pairs.find((pair) => pair.key.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function toNodeHeaders(pairs, bodyLength) {
  const obj = {};
  for (const pair of pairs) {
    if (pair.key.toLowerCase() === 'content-length') continue;
    if (obj[pair.key] == null) obj[pair.key] = pair.value;
    else if (Array.isArray(obj[pair.key])) obj[pair.key].push(pair.value);
    else obj[pair.key] = [obj[pair.key], pair.value];
  }
  if (bodyLength != null) obj['Content-Length'] = String(bodyLength);
  return obj;
}

function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return null;
}

function isTextContent(contentType, bytes) {
  const type = (contentType || '').toLowerCase();
  if (/^image\/|^audio\/|^video\/|octet-stream|pdf|zip|gzip|wasm/.test(type) && !type.includes('svg')) return false;
  if (/^text\/|json|xml|javascript|svg|x-www-form-urlencoded|graphql|yaml|\+json|\+xml/.test(type)) return true;
  const sample = bytes.subarray(0, 1024);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function rawRequest({ url, method, headerPairs, body, timeoutMs, insecure, signal, followRedirects }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let truncated = false;
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const bodyBuffer = body && body.length ? body : null;
    const req = lib.request(target, {
      method,
      headers: toNodeHeaders(headerPairs, bodyBuffer ? bodyBuffer.length : (method === 'GET' || method === 'HEAD' ? null : 0)),
      rejectUnauthorized: !insecure,
      timeout: timeoutMs,
    }, (res) => {
      const pairs = pairsFromRaw(res.rawHeaders);
      const location = headerValue(pairs, 'location');
      const status = res.statusCode || 0;
      if (followRedirects && status >= 300 && status < 400 && location) {
        res.resume();
        succeed({
          status,
          statusText: res.statusMessage || '',
          headers: pairs,
          body: Buffer.alloc(0),
          truncated: false,
          location,
        });
        return;
      }
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        if (received + chunk.length > MAX_BODY) {
          truncated = true;
          const room = MAX_BODY - received;
          if (room > 0) chunks.push(chunk.subarray(0, room));
          received = MAX_BODY;
          succeed({
            status,
            statusText: res.statusMessage || '',
            headers: pairs,
            body: Buffer.concat(chunks),
            truncated: true,
            location: '',
          });
          res.destroy();
          return;
        }
        received += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => succeed({
        status,
        statusText: res.statusMessage || '',
        headers: pairs,
        body: Buffer.concat(chunks),
        truncated,
        location: '',
      }));
      res.on('close', () => {
        if (!settled) {
          succeed({
            status,
            statusText: res.statusMessage || '',
            headers: pairs,
            body: Buffer.concat(chunks),
            truncated,
            location: '',
          });
        }
      });
      res.on('error', (err) => { if (!truncated) fail(err); });
    });

    const onAbort = () => {
      const timeout = signal?.reason === 'timeout';
      const err = new Error(timeout ? 'timeout' : 'aborted');
      err.code = timeout ? 'TIMEOUT' : 'ABORTED';
      req.destroy(err);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', () => {
      const err = new Error('timeout');
      err.code = 'TIMEOUT';
      req.destroy(err);
    });
    req.on('error', fail);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();

    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }
    function succeed(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
  });
}

async function buildBody(payload) {
  if (payload.formFields) {
    const parts = [];
    for (const field of payload.formFields) {
      if (field.type === 'file') {
        const filePath = String(field.value || '');
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          return { error: `Could not read “${filePath}”.` };
        }
        if (!stat.isFile()) return { error: `“${filePath}” is not a file.` };
        if (stat.size > MAX_FILE) return { error: `“${path.basename(filePath)}” is larger than 20 MB.` };
        const bytes = await fs.readFile(filePath);
        parts.push({
          name: field.key,
          filename: path.basename(filePath),
          value: bytes,
        });
      } else {
        parts.push({ name: field.key, value: String(field.value ?? '') });
      }
    }
    const multipart = RelayCore.buildMultipart(parts);
    return { buffer: Buffer.from(multipart.body), contentType: multipart.contentType };
  }
  if (payload.bodyText != null) return { buffer: Buffer.from(String(payload.bodyText), 'utf8') };
  return { buffer: null };
}

async function performRequest(payload, signal) {
  const warnings = [];
  const builtBody = await buildBody(payload);
  if (builtBody.error) return { error: builtBody.error };
  let headerPairs = (payload.headers || []).map((header) => ({
    key: String(header.key),
    value: String(header.value ?? ''),
  }));
  if (builtBody.contentType) {
    headerPairs = headerPairs.filter((header) => header.key.toLowerCase() !== 'content-type');
    headerPairs.push({ key: 'Content-Type', value: builtBody.contentType });
  }
  let method = String(payload.method || 'GET').toUpperCase();
  let currentUrl = String(payload.url);
  let body = builtBody.buffer;
  const seen = new Set();
  const deadline = Date.now() + payload.timeoutMs;
  let redirectCount = 0;

  for (let hop = 0; hop <= 10; hop += 1) {
    if (signal.aborted) {
      return signal.reason === 'timeout'
        ? { error: `Timed out after ${payload.timeoutMs} ms`, timedOut: true }
        : { error: 'Cancelled', cancelled: true };
    }
    const hopKey = `${method} ${currentUrl}`;
    if (seen.has(hopKey)) return { error: 'Stopped because the redirects looped.', warnings };
    seen.add(hopKey);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { error: `Timed out after ${payload.timeoutMs} ms`, timedOut: true, warnings };

    const response = await rawRequest({
      url: currentUrl,
      method,
      headerPairs,
      body,
      timeoutMs: remaining,
      insecure: payload.insecureTLS === true,
      signal,
      followRedirects: payload.followRedirects !== false,
    });

    const isRedirect = response.status >= 300 && response.status < 400 && response.location;
    if (!(payload.followRedirects && isRedirect)) {
      return describeResponse(response, currentUrl, redirectCount, warnings);
    }
    if (hop === 10) return { error: 'Stopped after 10 redirects.', warnings };
    const next = new URL(response.location, currentUrl);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return { error: 'Blocked a redirect to a non-http URL.', warnings };
    }
    const currentHost = new URL(currentUrl).host;
    if (next.host !== currentHost) {
      headerPairs = headerPairs.filter((header) => !['authorization', 'cookie', 'proxy-authorization'].includes(header.key.toLowerCase()));
      warnings.push(`Authorization and cookies were removed on redirect to ${next.host}.`);
    }
    if (response.status === 301 || response.status === 302 || response.status === 303) {
      if (method !== 'HEAD') method = 'GET';
      body = null;
      headerPairs = headerPairs.filter((header) => !['content-type', 'content-length'].includes(header.key.toLowerCase()));
    }
    currentUrl = next.toString();
    redirectCount += 1;
  }
  return { error: 'Stopped after 10 redirects.', warnings };
}

function describeResponse(response, finalUrl, redirectCount, warnings) {
  const contentTypeHeader = headerValue(response.headers, 'content-type');
  const sniffed = sniffImage(response.body);
  const contentType = sniffed || contentTypeHeader;
  const text = isTextContent(contentType, response.body);
  const image = String(contentType || '').toLowerCase().startsWith('image/') && !response.truncated && response.body.length <= 2_500_000;
  return {
    status: response.status,
    statusText: response.statusText,
    timeMs: 0,
    size: response.body.length,
    truncated: response.truncated,
    headers: response.headers,
    bodyText: text ? response.body.toString('utf8') : null,
    bodyBase64: !text ? response.body.toString('base64') : null,
    contentType,
    isText: text,
    isImage: image,
    finalUrl,
    redirectCount,
    warnings,
  };
}

ipcMain.handle('workspace:load', async () => {
  const file = workspaceFile();
  try {
    const text = await fs.readFile(file, 'utf8');
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, data: null };
    try {
      await fs.copyFile(file, `${file}.corrupt`);
    } catch {
      // Keep going even if the backup copy fails.
    }
    return {
      ok: true,
      data: null,
      warning: 'The saved workspace could not be read. It was backed up beside the original file, and Relay opened a fresh workspace.',
    };
  }
});

async function writeWorkspace(data) {
  const json = JSON.stringify(data);
  if (json.length > 20_000_000) return { ok: false, error: 'The workspace is too large to save.' };
  const file = workspaceFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, json, 'utf8');
  await fs.rename(temporary, file);
  return { ok: true };
}

ipcMain.handle('workspace:save', async (_event, data) => {
  try {
    return await writeWorkspace(data);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('workspace:saveSync', (event, data) => {
  try {
    const json = JSON.stringify(data);
    if (json.length > 20_000_000) {
      event.returnValue = { ok: false, error: 'The workspace is too large to save.' };
      return;
    }
    const file = workspaceFile();
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, json, 'utf8');
    event.returnValue = { ok: true };
  } catch (err) {
    event.returnValue = { ok: false, error: err.message };
  }
});

ipcMain.handle('workspace:export', async (_event, text) => {
  const result = await dialog.showSaveDialog({
    title: 'Export Relay workspace',
    defaultPath: 'relay-workspace.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, String(text ?? ''), 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('workspace:import', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import workspace or collection',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const text = await fs.readFile(result.filePaths[0], 'utf8');
  return { canceled: false, text, filePath: result.filePaths[0] };
});

ipcMain.handle('dialog:pickFile', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a file',
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('file:save', async (_event, payload) => {
  const result = await dialog.showSaveDialog({
    title: 'Save response',
    defaultPath: payload?.defaultName || 'response.txt',
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  if (payload?.base64) await fs.writeFile(result.filePath, Buffer.from(payload.base64, 'base64'));
  else await fs.writeFile(result.filePath, String(payload?.text ?? ''), 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('clipboard:write', (_event, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('request:cancel', (_event, requestId) => {
  const controller = inflight.get(requestId);
  if (controller) controller.abort();
  return true;
});

ipcMain.handle('request:send', async (_event, payload) => {
  const requestId = String(payload?.requestId || '');
  const method = String(payload?.method || 'GET').toUpperCase();
  if (!RelayCore.METHODS.includes(method)) return { error: 'That HTTP method is not supported.' };
  for (const header of payload?.headers || []) {
    if (!header || /[\r\n]/.test(String(header.key || '')) || /[\r\n]/.test(String(header.value ?? ''))) {
      return { error: 'A header is not valid.' };
    }
  }
  let target;
  try {
    target = new URL(String(payload?.url || ''));
  } catch {
    return { error: 'Enter a valid http or https URL.' };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { error: 'Only http and https URLs can be sent.' };
  }
  const timeoutMs = RelayCore.clampTimeout(payload?.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  if (requestId) inflight.set(requestId, controller);
  const started = process.hrtime.bigint();
  try {
    const result = await performRequest({ ...payload, method, url: target.toString(), timeoutMs }, controller.signal);
    if (result && !result.error) {
      result.timeMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e6));
    }
    return result;
  } catch (err) {
    if (err.code === 'TIMEOUT' || controller.signal.reason === 'timeout') {
      return { error: `Timed out after ${timeoutMs} ms`, timedOut: true };
    }
    if (err.code === 'ABORTED' || controller.signal.aborted) return { error: 'Cancelled', cancelled: true };
    return { error: formatNetError(err) };
  } finally {
    clearTimeout(timer);
    inflight.delete(requestId);
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
