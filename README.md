# Claude for Safari

Gives Claude Desktop the ability to control Safari — navigate pages, read content, click elements, fill forms — via the MCP protocol, just like "Claude in Chrome".

[![claudeForSafari MCP server](https://glama.ai/mcp/servers/Lyosis/claudeForSafari/badges/card.svg)](https://glama.ai/mcp/servers/Lyosis/claudeForSafari)
[![claudeForSafari MCP server](https://glama.ai/mcp/servers/Lyosis/claudeForSafari/badges/score.svg)](https://glama.ai/mcp/servers/Lyosis/claudeForSafari)

## Architecture

```
Claude Desktop  (MCP stdio)
      ↕  JSON-RPC
  bridge/bridge.js  (Node.js)
      ↕  WebSocket  ws://localhost:45678
Safari Extension background.js  (MV2)
      ↕  browser.tabs / executeScript
    Active Safari tab
```

---

## Repository structure

```
claudeForSafari/                  ← git root
├── .gitignore
├── README.md
├── bridge/                       ← Node.js bridge (MCP ↔ WebSocket)
│   ├── bridge.js
│   ├── package.json
│   └── package-lock.json
└── app/                          ← Xcode project
    ├── claudeExtension.xcodeproj
    ├── claudeExtension/          ← Swift host app (macOS)
    └── claudeExtension Extension/
        └── Resources/            ← SINGLE SOURCE for extension files
            ├── manifest.json
            ├── background.js
            ├── popup.html / popup.js / popup.css
            ├── images/
            └── _locales/
```

> **Rule:** all extension file edits go directly in `app/claudeExtension Extension/Resources/`. There is no separate `safari-extension/` folder.

---

## Requirements

- macOS 13+ (Ventura or later)
- Xcode 16+
- Node.js v20+ — [nodejs.org](https://nodejs.org) if not yet installed
- An Apple developer account (free account is enough for local use)
- Claude Desktop with MCP support

---

## Installation

### Step 1 — Clone the repository

```bash
git clone git@github.com:Lyosis/claudeForSafari.git
cd claudeForSafari
```

### Step 2 — Install bridge dependencies

```bash
cd bridge
npm install
cd ..
```

### Step 3 — Build the extension in Xcode

1. Open `app/claudeExtension.xcodeproj` in Xcode
2. Select the **claudeExtension** scheme (the host app)
3. Choose **My Mac** as the destination
4. Press **Cmd+R** — Xcode builds and launches the app

macOS will show a banner: *"claudeExtension wants to add a Safari extension"* → click **Open Safari Preferences** and enable the extension.

### Step 4 — Enable the extension in Safari

1. Safari → **Settings (Cmd+,)** → **Extensions** tab
2. Check **claudeExtension**
3. In the right column → **Allow on all websites**

> Without this permission, script injection into pages will fail silently.

### Step 5 — Configure Claude Desktop

Open (or create):

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add the `safari` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "safari": {
      "command": "node",
      "args": [
        "/absolute/path/to/claudeForSafari/bridge/bridge.js"
      ]
    }
  }
}
```

Replace `/absolute/path/to/` with the actual path where you cloned the repo.

If `node` is not in Claude Desktop's PATH, use its full path:

```bash
which node   # e.g. /usr/local/bin/node or /opt/homebrew/bin/node
```

Then **restart Claude Desktop**.

---

## Usage

The bridge starts automatically with Claude Desktop.  
Safari must be open with the extension enabled.

The extension reconnects automatically to the bridge after sleep or after visiting Safari Settings — no manual action required.

### Safari profiles

Each Safari profile runs its own copy of the extension. Give each one a name from the extension's toolbar popup (**Profile name**); unnamed profiles all register as `default`, and Claude then cannot tell them apart. Names are matched case-insensitively (`dev` matches `Dev`).

Every tool accepts a `profile` argument. To make Claude use one profile when it names none — recommended: a profile **dedicated to Claude**, so that it never browses with the sessions and cookies of your personal profiles — set `SAFARI_DEFAULT_PROFILE` in the server entry:

```json
"safari": {
  "command": "node",
  "args": ["/absolute/path/to/claudeForSafari/bridge/bridge.js"],
  "env": { "SAFARI_DEFAULT_PROFILE": "Dev" }
}
```

When that profile is not connected, tools fail with an explicit error instead of falling back to another profile. Without `SAFARI_DEFAULT_PROFILE`, the first connected profile is used, as before.

---

## Available tools (13)

| Tool | Description |
|---|---|
| `safari_list_profiles` | List available Safari profiles |
| `safari_navigate` | Navigate to a URL |
| `safari_get_page_text` | Read the visible text of the current page |
| `safari_read_page` | Get the full HTML of the current page |
| `safari_javascript` | Execute arbitrary JavaScript |
| `safari_find` | Find elements by CSS selector or text content |
| `safari_click` | Click an element |
| `safari_form_input` | Fill an `<input>` or `<textarea>` field |
| `safari_scroll` | Scroll the page |
| `safari_tabs_list` | List open tabs |
| `safari_tabs_create` | Open a new tab |
| `safari_tabs_close` | Close a tab |
| `safari_tabs_switch` | Switch to a tab by ID |

> `safari_form_input` supports `<input>` and `<textarea>` fields. Rich text editors using `contenteditable` (Notion, Gmail compose, etc.) are not yet supported.

---

## Troubleshooting

**"Safari extension not connected"**
- Is Safari open? Is the extension checked in Safari → Extensions — and, with Safari profiles, in Settings → Profiles → *your profile* → Extensions?
- Check the bridge is running: `ps aux | grep bridge.js`
- Bridge log (written by Claude Desktop): `~/Library/Logs/Claude/mcp-server-safari.log` — every line starts with `[claude-safari]`; refused connections and profile registrations are logged there.
- Extension log: Safari → Develop → *Web Extension Background Content* → Claude for Safari (enable the Develop menu in Settings → Advanced).

**Permission denied on script injection**  
→ Safari → Settings → Extensions → claudeExtension → **Allow on all websites**

**`safari_get_page_text` fails on an internal tab**  
→ Internal Safari pages (`favorites://`, `about:blank`, etc.) cannot be injected. Navigate to an `http://` or `https://` URL first.

**Bridge won't start**  
→ Check Node.js: `node -v` (v20+ required)  
→ Use the absolute path to `node` in `claude_desktop_config.json`

**Xcode — "No signing certificate"**  
→ Xcode → Settings → Accounts → add your Apple ID → Download Manual Profiles

---

## Security model

The bridge listens on `ws://localhost:45678`, bound to the loopback addresses only (`::1` and `127.0.0.1`): it is never reachable from the network.

**Web pages are refused.** Browsers always send an `Origin` header when a page opens a WebSocket, and a page cannot forge it. The bridge only accepts the Safari extension's origin (`safari-web-extension://…`); any other origin gets `403 Forbidden` and is written to the bridge log.

**A response is only accepted from the socket the command was sent to**, and command IDs are random — another client cannot answer in the extension's place.

**`safari_find` never returns the value of password fields** (it reports `<redacted>` when the field is filled).

What is *not* protected — there is no cryptographic authentication between the bridge and the extension, so the threat model assumes that:

- **other processes running under your user account are trusted** — clients without an `Origin` header (such as the relay bridges Claude Desktop starts) are accepted;
- **the other Safari extensions you installed are trusted** — they share the `safari-web-extension://` scheme.

`safari_javascript` executes arbitrary JavaScript in the active tab, and `safari_read_page` returns the full page HTML, by design. Treat them like browser DevTools — only use them on pages you trust.

> **Updating from 1.2.x:** quit Claude Desktop completely (Cmd+Q) after pulling, so that no bridge from the previous version keeps listening on the port.

## Development

All extension file edits go in:

```
app/claudeExtension Extension/Resources/
```

After editing `background.js` or `manifest.json`:

1. Rebuild in Xcode (Cmd+R)
2. Quit Safari (Cmd+Q) and reopen it — disabling and re-enabling the extension in Settings only reloads it in the current profile.

Build from a single checkout: building the project from a second folder (another clone, a worktree, `xcodebuild -derivedDataPath …`) registers a second copy of the extension, which Safari then loads alongside the first. `pluginkit -mAvvv -i com.wilfrid.B.claudeExtension.Extension` lists the registered copies.

The bridge (`bridge/bridge.js`) does not need a rebuild — Node.js picks up changes on the next Claude Desktop restart.

### Tests

```bash
cd bridge
npm ci
npm test
```

The tests run copies of the bridge on their own ports (never on 45678, so Claude Desktop can keep running) and `background.js` in a sandbox with fake browser APIs. They take about 30 seconds: they exercise the real reconnect and grace delays. The network test is skipped, with the reason shown, when the machine has no LAN address the test can reach. GitHub Actions runs them on every pull request.

What only a real Safari can check — after rebuilding the extension and restarting Safari:

1. **Version** — in a test tab, `safari_javascript` with `return browser.runtime.getManifest().version` returns the version you built.
2. **Origin** — the bridge log (`~/Library/Logs/Claude/mcp-server-safari.log`) shows `Profile "…" connected (origin safari-web-extension://…)`.
3. **Tools** — `safari_tabs_create`, `safari_find`, `safari_click`, `safari_form_input`, `safari_scroll`, `safari_tabs_close` on a page with a form; check the effects in the page itself.
4. **Web pages refused** — a page served over plain `http` that opens `ws://localhost:45678` gets an error, and the bridge log shows `Refused connection from origin "http://…"`.
5. **Host app** — opening `claudeExtension.app` shows the extension's state; its button quits the app and opens Safari Settings.

---

## License

MIT
