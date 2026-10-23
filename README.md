# Relay

Relay is a light Windows desktop HTTP client. It sends requests, keeps them in collections, substitutes environment variables, and includes a JSON beautifier.

## Requirements

- Windows
- [Node.js](https://nodejs.org/) (includes npm)

## Run

```bash
npm install
npm start
```

The first launch opens a sample collection and a JSONPlaceholder environment. Everything after that is stored locally.

## What you can do

- Send `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS` requests to `http` and `https` URLs.
- Edit query params, headers, and a body. Body modes are none, raw (JSON, text, XML, or HTML), `x-www-form-urlencoded`, and `form-data` (text or a file up to 20 MB).
- Add auth as a bearer token, basic auth, or an API key in a header or the query string.
- Set a timeout (1–180 seconds, 30 by default), follow redirects, and optionally accept invalid TLS certificates.
- Organize requests in collections. Search, rename, duplicate, and delete collections and requests.
- Open each request or environment in its own tab. Click a saved one, or create a new one, and it opens in a new tab. Tabs you leave open are restored the next time Relay starts.
- Keep global variables and named environments. The active environment overrides a global with the same name. Click an environment in the sidebar to edit its variables.
- Browse the last 50 sent requests and reopen any of them.
- Copy a request as a `curl.exe` command, and copy or save a response.
- Beautify or minify JSON in a request body, or from the **JSON** button in the header.
- Import a Relay workspace, a Postman collection, or a Postman environment. Export the current workspace as JSON.

Response bodies larger than 8 MB are truncated. Images preview in the response pane; other binary responses can be saved to disk.

## Variables

Use `{{name}}` in the URL, query params, headers, body, and auth. Unresolved names stay in the text and are listed under the URL before you send.

Built-in values:

| Token | Value |
| --- | --- |
| `{{$guid}}` / `{{$uuid}}` | A new UUID |
| `{{$timestamp}}` | Unix time in milliseconds |
| `{{$isoTimestamp}}` | Current time as an ISO 8601 string |
| `{{$randomInt}}` | An integer from 0 to 999 |

## Keyboard

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Send, or cancel the request in flight |
| Enter in the URL field | Send |
| Ctrl+S | Save the request into its collection |
| Ctrl+W | Close the current tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Switch to the next or previous tab |
| `/` | Focus the sidebar search (when not typing in a field) |
| Esc | Close the open dialog |
| F12 | Toggle developer tools |

Drag the splitter between the request and response to resize them. Double-click it to reset.

## Data

The workspace is saved as `workspace.json` in Relay’s Electron user data folder. On Windows that is `%APPDATA%\Relay`. Edits are written shortly after you make them, and again when the window closes. Open tabs are part of that file, including requests that are not in a collection yet.

If that file cannot be parsed, Relay copies it to `workspace.json.corrupt` and opens a fresh sample workspace.

**Import** accepts:

- a Relay workspace export (replace the current workspace, or merge collections, environments, and history into it)
- a Postman Collection v2 JSON file
- a Postman environment JSON file

**Export** writes the current workspace to a JSON file you choose.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Open the app |
| `npm test` | Run the core unit tests (requests, variables, JSON tools, Postman import) |
| `npm run smoke` | Launch the app against a local echo server and exercise send, environments, redirects, the beautifier, and save |

## Layout

```
electron-main.js    Window, HTTP, file dialogs, and workspace files
preload.js          Bridge from the window to the main process
src/index.html      App shell
src/app.js          Interface and workspace state
src/core.js         Request building, variables, cURL, JSON, and import
src/styles.css      Layout and theme
tests/core.test.js  Unit tests for src/core.js
scripts/smoke.js    End-to-end smoke test
```
