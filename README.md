# Claude for Safari

Permet à Claude de contrôler Safari — navigation, lecture de pages, clics, formulaires — exactement comme "Claude in Chrome".

## Architecture

```
Claude (MCP stdio)
      ↕  JSON-RPC
  bridge.js (Node.js)
      ↕  WebSocket  ws://localhost:45678
Safari Extension (background.js)
      ↕  browser.scripting / tabs API
    Page Safari
```

---

## Étape 1 — Installer Node.js

Si pas encore installé : https://nodejs.org (version LTS recommandée)

Vérifier :
```bash
node -v   # doit afficher v18+ ou v20+
npm -v
```

---

## Étape 2 — Installer les dépendances du bridge

```bash
cd /Users/wilfrid/Documents/Claude/Projects/extension\ Claude\ safari/bridge
npm install
```

---

## Étape 3 — Créer le projet Xcode pour l'extension Safari

Safari exige que toute extension soit embarquée dans une app macOS.

### 3a. Nouveau projet Xcode

1. Ouvrir **Xcode** → **File → New → Project**
2. Choisir **macOS → App**
3. Remplir :
   - Product Name : `ClaudeForSafari`
   - Team : ton compte développeur Apple
   - Bundle Identifier : `com.tonnom.ClaudeForSafari` *(adapter)*
   - Language : **Swift**
   - Uncheck "Include Tests"
4. Sauvegarder dans un dossier de ton choix

### 3b. Ajouter la cible Safari Web Extension

1. Dans Xcode : **File → New → Target**
2. Choisir **Safari Web Extension**
3. Product Name : `ClaudeForSafariExtension`
4. **Finish**

Xcode génère automatiquement des fichiers d'exemple dans la cible extension.

### 3c. Remplacer les fichiers JS par les nôtres

Dans le **Navigator** (panneau gauche), ouvre la cible `ClaudeForSafariExtension` et repère le dossier `Resources`.

Remplace les fichiers générés par ceux du dossier `safari-extension/` de ce projet :

| Fichier source (ce repo) | Destination dans Xcode |
|---|---|
| `safari-extension/manifest.json` | `Resources/manifest.json` |
| `safari-extension/background.js` | `Resources/background.js` |
| `safari-extension/content.js`    | `Resources/content.js`    |

**Méthode :** dans le Finder, fais glisser les fichiers depuis `safari-extension/` vers le dossier `Resources` dans Xcode en choisissant **"Replace"**.  
Ou édite directement les fichiers dans Xcode (copier-coller le contenu).

### 3d. Build & Run

1. Sélectionner le scheme **ClaudeForSafari** (l'app principale, pas l'extension)
2. Cmd+R pour builder et lancer
3. macOS affichera une bannière : *"ClaudeForSafari veut ajouter une extension Safari"* → **Autoriser**

### 3e. Activer l'extension dans Safari

1. Safari → **Réglages (Cmd+,)** → **Extensions**
2. Cocher **Claude for Safari**
3. Dans la popup de permissions → **Autoriser sur tous les sites**

---

## Étape 4 — Configurer Claude Desktop

Ouvrir (ou créer) le fichier de configuration MCP de Claude Desktop :

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
        "/Users/wilfrid/Documents/Claude/Projects/extension Claude safari/bridge/bridge.js"
      ]
    }
  }
}
```

*(Si le fichier contient déjà d'autres serveurs MCP, ajouter seulement la clé `"safari"` dans l'objet existant.)*

Puis **redémarrer Claude Desktop**.

---

## Étape 5 — Démarrage

À chaque session, le bridge se lance automatiquement avec Claude Desktop.  
Safari doit être ouvert avec l'extension activée.

Tu peux vérifier la connexion en regardant les logs dans la Console macOS (filtrer par `claude-safari`).

---

## Outils disponibles

| Outil | Description |
|---|---|
| `safari_navigate` | Naviguer vers une URL |
| `safari_get_page_text` | Lire le texte visible de la page |
| `safari_read_page` | Obtenir le HTML complet |
| `safari_javascript` | Exécuter du JavaScript |
| `safari_find` | Trouver des éléments (selector / texte) |
| `safari_click` | Cliquer sur un élément |
| `safari_form_input` | Remplir un champ de formulaire |
| `safari_scroll` | Faire défiler la page |
| `safari_tabs_list` | Lister les onglets ouverts |
| `safari_tabs_create` | Ouvrir un nouvel onglet |
| `safari_tabs_close` | Fermer un onglet |
| `safari_tabs_switch` | Activer un onglet |

---

## Dépannage

**"Safari extension not connected"**  
→ Safari est-il ouvert ? L'extension est-elle cochée dans Safari → Extensions ?  
→ Vérifier que le bridge tourne : `ps aux | grep bridge.js`

**Erreur de permission dans Safari**  
→ Safari → Réglages → Extensions → Claude for Safari → Autoriser sur tous les sites

**Le bridge ne démarre pas**  
→ Vérifier que `node` est dans le PATH de Claude Desktop :
```bash
which node   # noter le chemin complet, ex. /usr/local/bin/node
```
Utiliser ce chemin dans `claude_desktop_config.json` :
```json
"command": "/usr/local/bin/node"
```

**Xcode build error : "No signing certificate"**  
→ Xcode → Preferences → Accounts → ajouter ton Apple ID → Download Manual Profiles
