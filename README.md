# Claude for Safari

Permet à Claude Desktop de contrôler Safari — navigation, lecture de pages, clics, formulaires — via le protocole MCP, exactement comme "Claude in Chrome".

## Architecture

```
Claude Desktop  (MCP stdio)
      ↕  JSON-RPC
  bridge/bridge.js  (Node.js)
      ↕  WebSocket  ws://localhost:45678
Safari Extension background.js  (MV2)
      ↕  browser.tabs / executeScript
    Page Safari active
```

---

## Structure du dépôt

```
extension Claude safari/          ← racine git
├── .gitignore
├── README.md
├── bridge/                       ← pont Node.js (MCP ↔ WebSocket)
│   ├── bridge.js
│   ├── package.json
│   └── package-lock.json
└── app/                          ← projet Xcode
    ├── claudeExtension.xcodeproj
    ├── claudeExtension/          ← app hôte Swift (macOS)
    └── claudeExtension Extension/
        └── Resources/            ← SOURCE UNIQUE des fichiers de l'extension
            ├── manifest.json
            ├── background.js
            ├── content.js
            ├── popup.html / popup.js / popup.css
            ├── images/
            └── _locales/
```

> **Règle :** toute modification des fichiers de l'extension se fait directement dans `app/claudeExtension Extension/Resources/`. Il n'y a plus de dossier `safari-extension/` séparé.

---

## Prérequis

- macOS 14+ (Sonoma ou supérieur)
- Xcode 16+
- Node.js v18+ — [nodejs.org](https://nodejs.org) si pas encore installé
- Un compte développeur Apple (gratuit suffit pour usage local)
- Claude Desktop avec support MCP

---

## Installation

### Étape 1 — Cloner le dépôt

```bash
git clone git@github.com:Lyosis/claudeForSafari.git
cd claudeForSafari
```

### Étape 2 — Installer les dépendances du bridge

```bash
cd bridge
npm install
cd ..
```

### Étape 3 — Builder l'extension dans Xcode

1. Ouvrir `app/claudeExtension.xcodeproj` dans Xcode
2. Sélectionner le scheme **claudeExtension** (l'app hôte)
3. Choisir **My Mac** comme destination
4. **Cmd+R** — Xcode compile et lance l'app

macOS affiche une bannière *"claudeExtension veut ajouter une extension Safari"* → cliquer **Ouvrir les préférences Safari** et cocher l'extension.

### Étape 4 — Activer l'extension dans Safari

1. Safari → **Réglages (Cmd+,)** → onglet **Extensions**
2. Cocher **claudeExtension**
3. Dans la colonne de droite → **Autoriser sur tous les sites**

> Sans cette permission, l'injection de scripts dans les pages échouera silencieusement.

### Étape 5 — Configurer Claude Desktop

Ouvrir (ou créer) :

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Ajouter l'entrée `safari` dans `mcpServers` :

```json
{
  "mcpServers": {
    "safari": {
      "command": "node",
      "args": [
        "/chemin/absolu/vers/claudeForSafari/bridge/bridge.js"
      ]
    }
  }
}
```

Adapter `/chemin/absolu/vers/` selon l'emplacement du dépôt cloné.

Si `node` n'est pas dans le PATH de Claude Desktop, utiliser le chemin complet :

```bash
which node   # ex. /usr/local/bin/node ou /opt/homebrew/bin/node
```

Puis **redémarrer Claude Desktop**.

---

## Démarrage

Le bridge se lance automatiquement avec Claude Desktop.  
Safari doit être ouvert avec l'extension cochée.

L'extension se reconnecte automatiquement au bridge après une mise en veille ou une visite dans les Réglages Safari — aucune intervention manuelle nécessaire.

---

## Outils disponibles (13)

| Outil | Description |
|---|---|
| `safari_list_profiles` | Lister les profils Safari disponibles |
| `safari_navigate` | Naviguer vers une URL |
| `safari_get_page_text` | Lire le texte visible de la page |
| `safari_read_page` | Obtenir le HTML complet |
| `safari_javascript` | Exécuter du JavaScript arbitraire |
| `safari_find` | Trouver des éléments (CSS selector ou texte) |
| `safari_click` | Cliquer sur un élément |
| `safari_form_input` | Remplir un champ `<input>` ou `<textarea>` |
| `safari_scroll` | Faire défiler la page |
| `safari_tabs_list` | Lister les onglets ouverts |
| `safari_tabs_create` | Ouvrir un nouvel onglet |
| `safari_tabs_close` | Fermer un onglet |
| `safari_tabs_switch` | Activer un onglet par ID |

> `safari_form_input` supporte les champs `<input>` et `<textarea>`. Les éditeurs riches de type `contenteditable` (Notion, Gmail compose…) ne sont pas encore supportés.

---

## Dépannage

**"Safari extension not connected"**
- Safari est-il ouvert ? L'extension est-elle cochée ?
- Vérifier que le bridge tourne : `ps aux | grep bridge.js`
- Regarder les logs : Console.app → filtrer `claude-safari`

**Permission refusée lors de l'injection**
→ Safari → Réglages → Extensions → claudeExtension → **Autoriser sur tous les sites**

**`safari_get_page_text` échoue sur un onglet interne**  
→ Les pages internes Safari (`favorites://`, `about:blank`…) ne peuvent pas être injectées. Naviguer d'abord vers une URL `http://` ou `https://`.

**Le bridge ne démarre pas**
→ Vérifier Node.js : `node -v` (v18+ requis)  
→ Utiliser le chemin absolu de `node` dans `claude_desktop_config.json`

**Xcode — "No signing certificate"**
→ Xcode → Settings → Accounts → ajouter l'Apple ID → Download Manual Profiles

---

## Développement

Toute modification de l'extension se fait dans :

```
app/claudeExtension Extension/Resources/
```

Après modification de `background.js` ou `manifest.json` :

1. Rebuilder dans Xcode (Cmd+R)
2. Safari → Réglages → Extensions → désactiver puis réactiver l'extension  
   *(ou relancer Safari)*

Le bridge (`bridge/bridge.js`) ne nécessite pas de rebuild — Node.js le recharge au prochain démarrage de Claude Desktop.

---

## Licence

Projet privé — usage personnel.
