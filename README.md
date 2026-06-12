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
            ├── content.js
            ├── popup.html / popup.js / popup.css
            ├── images/
            └── _locales/
```

> **Rule:** all extension file edits go directly in `app/claudeExtension Extension/Resources/`. There is no separate `safari-extension/` folder.

---

## Requirements

- macOS 14+ (Sonoma or later)
- Xcode 16+
- Node.js v18+ — [nodejs.org](https://nodejs.org) if not yet installed
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
- Is Safari open? Is the extension checked in Safari → Extensions?
- Check the bridge is running: `ps aux | grep bridge.js`
- Check logs: Console.app → filter by `claude-safari`

**Permission denied on script injection**  
→ Safari → Settings → Extensions → claudeExtension → **Allow on all websites**

**`safari_get_page_text` fails on an internal tab**  
→ Internal Safari pages (`favorites://`, `about:blank`, etc.) cannot be injected. Navigate to an `http://` or `https://` URL first.

**Bridge won't start**  
→ Check Node.js: `node -v` (v18+ required)  
→ Use the absolute path to `node` in `claude_desktop_config.json`

**Xcode — "No signing certificate"**  
→ Xcode → Settings → Accounts → add your Apple ID → Download Manual Profiles

---

## Security model

The bridge listens on `ws://localhost:45678` — **localhost only**, never exposed to the network.

However, any local process can connect to that port. There is no cryptographic authentication between the bridge and the Safari extension. The threat model assumes that other processes running under your user account are trusted. If you run untrusted local software, be aware that it could theoretically connect to the bridge.

`safari_javascript` executes arbitrary JavaScript in the active tab by design. Treat it like browser DevTools — only use it on pages you trust.

## Development

All extension file edits go in:

```
app/claudeExtension Extension/Resources/
```

After editing `background.js` or `manifest.json`:

1. Rebuild in Xcode (Cmd+R)
2. Safari → Settings → Extensions → disable then re-enable the extension  
   *(or restart Safari)*

The bridge (`bridge/bridge.js`) does not need a rebuild — Node.js picks up changes on the next Claude Desktop restart.

---

## License

MIT
