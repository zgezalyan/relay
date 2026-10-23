(function () {
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const DYNAMICS = new Set(['$guid', '$uuid', '$timestamp', '$isoTimestamp', '$randomInt']);
  const VAR_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

  function newId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function clampTimeout(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 30000;
    return Math.min(180000, Math.max(1000, Math.round(n)));
  }

  function createEmptyDraft() {
    return {
      name: 'Untitled request',
      method: 'GET',
      url: '',
      params: [],
      headers: [],
      bodyMode: 'none',
      rawType: 'json',
      rawBody: '',
      urlencoded: [],
      formdata: [],
      authType: 'none',
      auth: {
        bearerToken: '',
        basicUser: '',
        basicPass: '',
        apiKey: '',
        apiValue: '',
        apiIn: 'header',
      },
      timeoutMs: 30000,
      followRedirects: true,
      insecureTLS: false,
    };
  }

  function blankRow(form) {
    const row = {
      id: newId(),
      key: '',
      value: '',
      description: '',
      enabled: true,
    };
    if (form) row.type = 'text';
    return row;
  }

  function rowHasContent(row) {
    return Boolean(
      String(row?.key || '').trim()
      || String(row?.value || '').trim()
      || String(row?.description || '').trim()
    );
  }

  function ensureTrailing(rows, form) {
    const list = rows || [];
    if (list.length === 0 || rowHasContent(list[list.length - 1])) {
      list.push(blankRow(form));
    }
    return list;
  }

  function stripRows(rows) {
    return (rows || []).filter(rowHasContent).map((row) => ({
      id: row.id || newId(),
      key: String(row.key ?? ''),
      value: String(row.value ?? ''),
      description: String(row.description ?? ''),
      enabled: row.enabled !== false,
      ...(row.type ? { type: row.type === 'file' ? 'file' : 'text' } : {}),
    }));
  }

  function stripVars(vars) {
    return (vars || []).filter((row) => String(row?.key || '').trim() || String(row?.value || '').trim());
  }

  function ensureVarTrailing(vars) {
    return ensureTrailing(vars, false);
  }

  function cloneRows(rows, form) {
    return (rows || []).map((row) => ({
      id: row.id || newId(),
      key: String(row.key ?? ''),
      value: String(row.value ?? ''),
      description: String(row.description ?? ''),
      enabled: row.enabled !== false,
      ...(form ? { type: row.type === 'file' ? 'file' : 'text' } : {}),
    }));
  }

  function normalizeRequest(draft) {
    const base = createEmptyDraft();
    const src = draft || {};
    const method = String(src.method || 'GET').toUpperCase();
    const formdata = stripRows(src.formdata).map((row) => ({
      ...row,
      type: row.type === 'file' ? 'file' : 'text',
    }));
    return {
      name: String(src.name || base.name).slice(0, 160) || base.name,
      method: METHODS.includes(method) ? method : 'GET',
      url: String(src.url ?? ''),
      params: stripRows(src.params).map(({ type, ...row }) => row),
      headers: stripRows(src.headers).map(({ type, ...row }) => row),
      bodyMode: ['none', 'raw', 'urlencoded', 'formdata'].includes(src.bodyMode) ? src.bodyMode : 'none',
      rawType: ['json', 'text', 'xml', 'html'].includes(src.rawType) ? src.rawType : 'json',
      rawBody: String(src.rawBody ?? ''),
      urlencoded: stripRows(src.urlencoded).map(({ type, ...row }) => row),
      formdata,
      authType: ['none', 'bearer', 'basic', 'apikey'].includes(src.authType) ? src.authType : 'none',
      auth: {
        bearerToken: String(src.auth?.bearerToken ?? ''),
        basicUser: String(src.auth?.basicUser ?? ''),
        basicPass: String(src.auth?.basicPass ?? ''),
        apiKey: String(src.auth?.apiKey ?? ''),
        apiValue: String(src.auth?.apiValue ?? ''),
        apiIn: src.auth?.apiIn === 'query' ? 'query' : 'header',
      },
      timeoutMs: clampTimeout(src.timeoutMs),
      followRedirects: src.followRedirects !== false,
      insecureTLS: src.insecureTLS === true,
    };
  }

  function hydrateDraft(raw) {
    const normalized = normalizeRequest(raw || createEmptyDraft());
    return {
      ...normalized,
      params: ensureTrailing(cloneRows(normalized.params, false)),
      headers: ensureTrailing(cloneRows(normalized.headers, false)),
      urlencoded: ensureTrailing(cloneRows(normalized.urlencoded, false)),
      formdata: ensureTrailing(cloneRows(normalized.formdata, true), true),
    };
  }

  function splitUrl(raw) {
    const value = String(raw ?? '');
    const hashAt = value.indexOf('#');
    const beforeHash = hashAt >= 0 ? value.slice(0, hashAt) : value;
    const hash = hashAt >= 0 ? value.slice(hashAt) : '';
    const queryAt = beforeHash.indexOf('?');
    return {
      base: queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash,
      query: queryAt >= 0 ? beforeHash.slice(queryAt + 1) : '',
      hash,
    };
  }

  function parseQuery(query) {
    if (!query) return [];
    const params = new URLSearchParams(query);
    const rows = [];
    for (const [key, value] of params.entries()) {
      rows.push({ key, value });
    }
    return rows;
  }

function encodeQueryPiece(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/%7B/gi, '{')
    .replace(/%7D/gi, '}');
}

function applyParamsToUrl(url, params) {
  const parts = splitUrl(url);
  const pairs = [];
  for (const row of params || []) {
    if (!row || row.enabled === false) continue;
    if (!String(row.key || '') && !String(row.value || '')) continue;
    pairs.push(`${encodeQueryPiece(row.key)}=${encodeQueryPiece(row.value ?? '')}`);
  }
  const query = pairs.join('&');
  return `${parts.base}${query ? `?${query}` : ''}${parts.hash}`;
}

  function syncParamsFromUrl(url, existing) {
    const parsed = parseQuery(splitUrl(url).query);
    const source = existing || [];
    const used = new Set();
    const enabled = parsed.map((pair) => {
      const matchIndex = source.findIndex((row, index) => (
        !used.has(index) && row.enabled !== false && row.key === pair.key
      ));
      if (matchIndex >= 0) {
        used.add(matchIndex);
        return { ...source[matchIndex], key: pair.key, value: pair.value, enabled: true };
      }
      return {
        id: newId(),
        key: pair.key,
        value: pair.value,
        description: '',
        enabled: true,
      };
    });
    const disabled = source.filter((row, index) => !used.has(index) && row.enabled === false && rowHasContent(row));
    return [...enabled, ...disabled];
  }

  function isForbiddenKey(key) {
    return key === '__proto__' || key === 'prototype' || key === 'constructor';
  }

  function buildScope(globals, environment) {
    const map = Object.create(null);
    const apply = (vars) => {
      for (const row of vars || []) {
        if (!row || row.enabled === false) continue;
        const key = String(row.key || '').trim();
        if (!key || isForbiddenKey(key)) continue;
        map[key] = String(row.value ?? '');
      }
    };
    apply(globals?.variables);
    apply(environment?.variables);
    return map;
  }

  function dynamicValue(name) {
    switch (name) {
      case '$guid':
      case '$uuid':
        return newId();
      case '$timestamp':
        return String(Date.now());
      case '$isoTimestamp':
        return new Date().toISOString();
      case '$randomInt':
        return String(Math.floor(Math.random() * 1000));
      default:
        return null;
    }
  }

  function interpolate(input, vars) {
    let current = String(input ?? '');
    const seen = new Set();
    for (let pass = 0; pass < 8; pass += 1) {
      if (!current.includes('{{')) break;
      let changed = false;
      current = current.replace(VAR_PATTERN, (full, rawName) => {
        const name = String(rawName || '').trim();
        const dynamic = dynamicValue(name);
        if (dynamic !== null) {
          changed = true;
          return dynamic;
        }
        if (Object.prototype.hasOwnProperty.call(vars || Object.create(null), name)) {
          changed = true;
          return String(vars[name]);
        }
        return full;
      });
      if (!changed || seen.has(current)) break;
      seen.add(current);
    }
    return current;
  }

  function collectMissing(input, missing) {
    String(input ?? '').replace(VAR_PATTERN, (full, rawName) => {
      const name = String(rawName || '').trim();
      if (!name) return full;
      if (name.startsWith('$') && DYNAMICS.has(name)) return full;
      missing.add(name);
      return full;
    });
  }

  function encodeBasic(user, pass) {
    const bytes = new TextEncoder().encode(`${user ?? ''}:${pass ?? ''}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof btoa === 'function') return btoa(binary);
    return Buffer.from(bytes).toString('base64');
  }

  function activeRows(rows) {
    return (rows || []).filter((row) => row && row.enabled !== false && String(row.key || '').trim());
  }

  function isValidHeaderName(name) {
    return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
  }

  function contentTypeForRaw(rawType) {
    switch (rawType) {
      case 'xml': return 'application/xml';
      case 'html': return 'text/html';
      case 'text': return 'text/plain; charset=utf-8';
      default: return 'application/json';
    }
  }

  function buildOutgoing(draft, scope) {
    const source = draft || createEmptyDraft();
    const warnings = [];
    const missing = new Set();
    const method = METHODS.includes(String(source.method || 'GET').toUpperCase())
      ? String(source.method || 'GET').toUpperCase()
      : 'GET';
    const read = (value) => {
      const text = String(value ?? '');
      const resolved = interpolate(text, scope);
      collectMissing(resolved, missing);
      return resolved;
    };

    let url = read(String(source.url || '').trim());
    const headers = [];
    for (const row of activeRows(source.headers)) {
      const key = read(String(row.key).trim());
      const value = read(row.value ?? '');
      if (!isValidHeaderName(key) || /[\r\n]/.test(value)) {
        return fail(`Header “${key || row.key}” is not valid.`, warnings, missing, partial(method, url));
      }
      headers.push({ key, value });
    }

    const hasHeader = (name) => headers.some((header) => header.key.toLowerCase() === name.toLowerCase());
    const upsert = (key, value) => {
      const index = headers.findIndex((header) => header.key.toLowerCase() === key.toLowerCase());
      if (index >= 0) headers[index] = { key, value };
      else headers.push({ key, value });
    };

    const authType = source.authType || 'none';
    const auth = source.auth || {};
    if (authType === 'bearer') {
      const token = read(auth.bearerToken).trim();
      if (!token) return fail('Enter a bearer token.', warnings, missing, partial(method, url, headers));
      if (hasHeader('authorization')) warnings.push('The Authorization header was replaced by the Auth tab.');
      upsert('Authorization', `Bearer ${token}`);
    } else if (authType === 'basic') {
      const username = read(auth.basicUser);
      const password = read(auth.basicPass);
      if (!username) return fail('Enter a username for basic auth.', warnings, missing, partial(method, url, headers));
      if (hasHeader('authorization')) warnings.push('The Authorization header was replaced by the Auth tab.');
      upsert('Authorization', `Basic ${encodeBasic(username, password)}`);
    } else if (authType === 'apikey') {
      const key = read(auth.apiKey).trim();
      const value = read(auth.apiValue);
      if (!key) return fail('Enter an API key name.', warnings, missing, partial(method, url, headers));
      if ((auth.apiIn || 'header') === 'query') {
        try {
          const parsed = new URL(url);
          parsed.searchParams.append(key, value);
          url = parsed.toString();
        } catch {
          return fail('The URL must be valid before an API key can be added to the query.', warnings, missing, partial(method, url, headers));
        }
      } else {
        if (!isValidHeaderName(key)) return fail(`API key header “${key}” is not valid.`, warnings, missing, partial(method, url, headers));
        if (hasHeader(key)) warnings.push(`The ${key} header was replaced by the Auth tab.`);
        upsert(key, value);
      }
    }

    let bodyText = null;
    let formFields = null;
    const sendsBody = method !== 'GET' && method !== 'HEAD';
    if (!sendsBody && source.bodyMode && source.bodyMode !== 'none') {
      warnings.push('GET and HEAD requests are sent without a body.');
    }
    if (sendsBody && source.bodyMode === 'raw') {
      bodyText = read(source.rawBody ?? '');
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: contentTypeForRaw(source.rawType) });
    } else if (sendsBody && source.bodyMode === 'urlencoded') {
      const search = new URLSearchParams();
      for (const row of activeRows(source.urlencoded)) {
        search.append(read(String(row.key).trim()), read(row.value ?? ''));
      }
      bodyText = search.toString();
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
    } else if (sendsBody && source.bodyMode === 'formdata') {
      formFields = [];
      for (const row of activeRows(source.formdata)) {
        const key = read(String(row.key).trim());
        const value = read(row.value ?? '');
        if (/["\r\n]/.test(key)) return fail(`Form field “${key}” is not valid.`, warnings, missing, partial(method, url, headers));
        if (row.type === 'file' && !value.trim()) {
          return fail(`Choose a file for “${key}”.`, warnings, missing, partial(method, url, headers));
        }
        formFields.push({ key, value, type: row.type === 'file' ? 'file' : 'text' });
      }
      if (hasHeader('content-type')) {
        warnings.push('Content-Type was replaced so the form-data boundary stays valid.');
        const index = headers.findIndex((header) => header.key.toLowerCase() === 'content-type');
        headers.splice(index, 1);
      }
    }

    if (!hasHeader('accept')) headers.push({ key: 'Accept', value: '*/*' });
    if (!hasHeader('user-agent')) headers.push({ key: 'User-Agent', value: 'Relay/1.0' });

    let error = null;
    if (!url) error = 'Enter a URL.';
    else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          error = 'Only http and https URLs can be sent.';
        }
      } catch {
        error = 'Enter a valid http or https URL.';
      }
    }

    return {
      ok: !error,
      error,
      warnings,
      missing: [...missing],
      request: {
        method,
        url,
        headers,
        bodyText,
        formFields,
        timeoutMs: clampTimeout(source.timeoutMs),
        followRedirects: source.followRedirects !== false,
        insecureTLS: source.insecureTLS === true,
      },
    };
  }

  function partial(method, url, headers) {
    return {
      method,
      url,
      headers: headers || [],
      bodyText: null,
      formFields: null,
      timeoutMs: 30000,
      followRedirects: true,
      insecureTLS: false,
    };
  }

  function fail(error, warnings, missing, request) {
    return { ok: false, error, warnings, missing: [...missing], request };
  }

  function quoteCmd(value) {
    return `"${String(value ?? '').replace(/"/g, '\\"')}"`;
  }

  function toCurl(built) {
    const request = built?.request;
    if (!request?.url) return '';
    const parts = ['curl.exe', '-X', request.method, quoteCmd(request.url)];
    if (request.followRedirects) parts.push('-L');
    if (request.insecureTLS) parts.push('--insecure');
    parts.push('--max-time', String(Math.max(1, Math.ceil(request.timeoutMs / 1000))));
    for (const header of request.headers) {
      if (request.formFields && header.key.toLowerCase() === 'content-type') continue;
      parts.push('-H', quoteCmd(`${header.key}: ${header.value}`));
    }
    if (request.formFields) {
      for (const field of request.formFields) {
        const value = field.type === 'file' ? `@${field.value}` : String(field.value ?? '');
        parts.push('-F', quoteCmd(`${field.key}=${value}`));
      }
    } else if (request.bodyText != null) {
      parts.push('--data-raw', quoteCmd(request.bodyText));
    }
    return parts.join(' ');
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function buildMultipart(fields) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    const boundary = `----Relay${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    const encoder = new TextEncoder();
    const chunks = [];
    const push = (text) => chunks.push(encoder.encode(text));
    for (const field of fields || []) {
      const name = String(field.name ?? '');
      if (field.filename) {
        const filename = String(field.filename).replace(/"/g, '');
        push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const body = field.value instanceof Uint8Array ? field.value : encoder.encode(String(field.value ?? ''));
        chunks.push(body);
        push('\r\n');
      } else {
        push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${field.value ?? ''}\r\n`);
      }
    }
    push(`--${boundary}--\r\n`);
    return {
      body: concatBytes(chunks),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  function beautifyJson(text) {
    const source = String(text ?? '').trim();
    if (!source) return { ok: false, error: 'Enter JSON first.' };
    try {
      return { ok: true, text: JSON.stringify(JSON.parse(source), null, 2) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function minifyJson(text) {
    const source = String(text ?? '').trim();
    if (!source) return { ok: false, error: 'Enter JSON first.' };
    try {
      return { ok: true, text: JSON.stringify(JSON.parse(source)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function highlightJson(text) {
    const escaped = String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(
      /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'json-number';
        if (match.startsWith('"')) cls = /:\s*$/.test(match) ? 'json-key' : 'json-string';
        else if (match === 'true' || match === 'false') cls = 'json-bool';
        else if (match === 'null') cls = 'json-null';
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  function formatBytes(size) {
    const n = Number(size) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function asText(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value.content === 'string') return value.content;
    return '';
  }

  function authFromPostman(auth) {
    const result = {
      authType: 'none',
      auth: createEmptyDraft().auth,
    };
    if (!auth || !auth.type || auth.type === 'noauth') return result;
    const bag = (key) => {
      const list = Array.isArray(auth[key]) ? auth[key] : [];
      const map = Object.create(null);
      for (const entry of list) map[entry.key] = entry.value ?? '';
      return map;
    };
    if (auth.type === 'bearer') {
      result.authType = 'bearer';
      result.auth.bearerToken = String(bag('bearer').token ?? '');
    } else if (auth.type === 'basic') {
      const basic = bag('basic');
      result.authType = 'basic';
      result.auth.basicUser = String(basic.username ?? '');
      result.auth.basicPass = String(basic.password ?? '');
    } else if (auth.type === 'apikey') {
      const api = bag('apikey');
      result.authType = 'apikey';
      result.auth.apiKey = String(api.key ?? '');
      result.auth.apiValue = String(api.value ?? '');
      result.auth.apiIn = api.in === 'query' ? 'query' : 'header';
    }
    return result;
  }

  function requestFromPostman(request, name) {
    const rawUrl = typeof request?.url === 'string' ? request.url : String(request?.url?.raw || '');
    let params = [];
    if (request?.url && Array.isArray(request.url.query)) {
      params = request.url.query.map((row) => ({
        id: newId(),
        key: String(row.key ?? ''),
        value: String(row.value ?? ''),
        description: asText(row.description),
        enabled: row.disabled !== true,
      }));
    }
    let url = rawUrl;
    if (params.length) url = applyParamsToUrl(rawUrl, params);
    else params = syncParamsFromUrl(rawUrl, []).filter(rowHasContent);

    const headers = (request?.header || []).map((row) => ({
      id: newId(),
      key: String(row.key ?? ''),
      value: String(row.value ?? ''),
      description: asText(row.description),
      enabled: row.disabled !== true,
    }));

    let bodyMode = 'none';
    let rawType = 'json';
    let rawBody = '';
    let urlencoded = [];
    let formdata = [];
    const mode = request?.body?.mode;
    if (mode === 'raw') {
      bodyMode = 'raw';
      rawBody = String(request.body.raw ?? '');
      const language = request.body.options?.raw?.language;
      rawType = ['json', 'xml', 'html', 'text'].includes(language) ? language : 'text';
      if (language === 'json') rawType = 'json';
    } else if (mode === 'graphql') {
      bodyMode = 'raw';
      rawType = 'text';
      rawBody = String(request.body.graphql?.query ?? '');
    } else if (mode === 'urlencoded') {
      bodyMode = 'urlencoded';
      urlencoded = (request.body.urlencoded || []).map((row) => ({
        id: newId(),
        key: String(row.key ?? ''),
        value: String(row.value ?? ''),
        description: asText(row.description),
        enabled: row.disabled !== true,
      }));
    } else if (mode === 'formdata') {
      bodyMode = 'formdata';
      formdata = (request.body.formdata || []).map((row) => ({
        id: newId(),
        key: String(row.key ?? ''),
        value: String(row.type === 'file' ? (row.src || row.value || '') : (row.value ?? '')),
        description: asText(row.description),
        enabled: row.disabled !== true,
        type: row.type === 'file' ? 'file' : 'text',
      }));
    }

    const auth = authFromPostman(request?.auth);
    return {
      id: newId(),
      ...normalizeRequest({
        name: name || 'Imported request',
        method: request?.method || 'GET',
        url,
        params,
        headers,
        bodyMode,
        rawType,
        rawBody,
        urlencoded,
        formdata,
        authType: auth.authType,
        auth: auth.auth,
      }),
    };
  }

  function walkPostmanItems(items, prefix, out) {
    for (const item of items || []) {
      const itemName = String(item?.name || 'Untitled');
      if (Array.isArray(item?.item)) {
        walkPostmanItems(item.item, prefix ? `${prefix} / ${itemName}` : itemName, out);
      }
      if (item?.request) {
        const name = prefix ? `${prefix} / ${itemName}` : itemName;
        out.push(requestFromPostman(item.request, name));
      }
    }
  }

  function postmanCollectionToRelay(data) {
    const requests = [];
    walkPostmanItems(data.item, '', requests);
    return {
      id: newId(),
      name: String(data.info?.name || 'Imported collection').slice(0, 160),
      requests,
    };
  }

  function postmanEnvToRelay(data) {
    const values = Array.isArray(data.values) ? data.values : [];
    return {
      id: newId(),
      name: String(data.name || 'Imported environment').slice(0, 160),
      variables: values.filter((row) => row && !isForbiddenKey(String(row.key || '').trim())).map((row) => ({
        id: newId(),
        key: String(row.key ?? ''),
        value: String(row.value ?? ''),
        description: '',
        enabled: row.enabled !== false,
      })).filter((row) => row.key || row.value),
    };
  }

  function sanitizeVars(vars) {
    return (vars || []).filter((row) => row && typeof row === 'object' && !isForbiddenKey(String(row.key || '').trim())).map((row) => ({
      id: String(row.id || newId()),
      key: String(row.key ?? ''),
      value: String(row.value ?? ''),
      description: String(row.description ?? ''),
      enabled: row.enabled !== false,
    })).filter((row) => row.key || row.value);
  }

  function sanitizeCollection(collection) {
    if (!collection || typeof collection !== 'object') return null;
    const requests = [];
    for (const request of collection.requests || []) {
      try {
        requests.push({ id: String(request.id || newId()), ...normalizeRequest(request) });
      } catch {
        // Skip a broken request and keep the rest of the collection.
      }
    }
    return {
      id: String(collection.id || newId()),
      name: String(collection.name || 'Collection').slice(0, 160),
      requests,
    };
  }

  function sanitizeWorkspace(data) {
    const source = data && typeof data === 'object' ? data : {};
    const environments = (source.environments || []).filter((env) => env && typeof env === 'object').map((env) => ({
      id: String(env.id || newId()),
      name: String(env.name || 'Environment').slice(0, 160),
      variables: sanitizeVars(env.variables),
    }));
    let activeEnvironmentId = source.activeEnvironmentId ? String(source.activeEnvironmentId) : null;
    if (activeEnvironmentId && !environments.some((env) => env.id === activeEnvironmentId)) activeEnvironmentId = null;
    const history = [];
    for (const item of Array.isArray(source.history) ? source.history.slice(0, 50) : []) {
      if (!item || typeof item !== 'object' || !item.draft) continue;
      try {
        history.push({
          id: String(item.id || newId()),
          at: Number(item.at) || Date.now(),
          method: String(item.method || 'GET'),
          url: String(item.url || ''),
          status: item.status == null ? null : Number(item.status),
          ok: Boolean(item.ok),
          timeMs: Number(item.timeMs) || 0,
          error: item.error ? String(item.error) : null,
          draft: normalizeRequest(item.draft),
        });
      } catch {
        // Ignore a broken history entry.
      }
    }
    return {
      version: 1,
      globals: { variables: sanitizeVars(source.globals?.variables) },
      environments,
      activeEnvironmentId,
      collections: (source.collections || []).map(sanitizeCollection).filter(Boolean),
      history,
      draft: source.draft ? normalizeRequest(source.draft) : null,
      loaded: source.loaded && source.loaded.collectionId && source.loaded.requestId
        ? { collectionId: String(source.loaded.collectionId), requestId: String(source.loaded.requestId) }
        : null,
    };
  }

  function detectImport(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'unknown';
    if (Array.isArray(data.collections) && (data.version || data.environments || data.globals)) return 'relay';
    if (Array.isArray(data.item) && data.info) return 'postman-collection';
    if (Array.isArray(data.values) && typeof data.name === 'string') return 'postman-environment';
    return 'unknown';
  }

  function readImported(data) {
    const kind = detectImport(data);
    if (kind === 'relay') return { kind, workspace: sanitizeWorkspace(data) };
    if (kind === 'postman-collection') return { kind, collection: postmanCollectionToRelay(data) };
    if (kind === 'postman-environment') return { kind, environment: postmanEnvToRelay(data) };
    return { kind: 'unknown' };
  }

  function createSampleWorkspace() {
    const envId = 'env-jsonplaceholder';
    const colId = 'col-example';
    const getRequest = {
      id: 'req-get-post',
      ...normalizeRequest({
        name: 'Get post',
        method: 'GET',
        url: '{{baseUrl}}/posts/1',
      }),
    };
    const postRequest = {
      id: 'req-create-post',
      ...normalizeRequest({
        name: 'Create post',
        method: 'POST',
        url: '{{baseUrl}}/posts',
        bodyMode: 'raw',
        rawType: 'json',
        rawBody: '{\n  "title": "Relay",\n  "body": "Sent from Relay",\n  "userId": 1\n}',
      }),
    };
    return {
      version: 1,
      globals: { variables: [] },
      activeEnvironmentId: envId,
      environments: [
        {
          id: envId,
          name: 'JSONPlaceholder',
          variables: [
            {
              id: 'var-base',
              key: 'baseUrl',
              value: 'https://jsonplaceholder.typicode.com',
              enabled: true,
            },
          ],
        },
      ],
      collections: [
        {
          id: colId,
          name: 'Example',
          requests: [getRequest, postRequest],
        },
      ],
      history: [],
      draft: normalizeRequest(getRequest),
      loaded: { collectionId: colId, requestId: getRequest.id },
    };
  }

  const RelayCore = {
    METHODS,
    newId,
    clampTimeout,
    createEmptyDraft,
    blankRow,
    ensureTrailing,
    ensureVarTrailing,
    stripRows,
    stripVars,
    normalizeRequest,
    hydrateDraft,
    splitUrl,
    parseQuery,
    applyParamsToUrl,
    syncParamsFromUrl,
    buildScope,
    interpolate,
    encodeBasic,
    buildOutgoing,
    toCurl,
    buildMultipart,
    beautifyJson,
    minifyJson,
    highlightJson,
    formatBytes,
    detectImport,
    readImported,
    sanitizeWorkspace,
    createSampleWorkspace,
  };

  globalThis.RelayCore = RelayCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = RelayCore;
})();
