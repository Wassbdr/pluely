# Pont Claude Code pour Pluely

Ce dossier contient `server.mjs`, un petit serveur HTTP local (Node pur, zéro dépendance) qui expose **Claude Code** derrière une API compatible OpenAI. Pluely s'y connecte comme à n'importe quel provider personnalisé : le moteur de chat n'a pas été modifié.

```
Pluely (webview)  --HTTP/SSE-->  server.mjs (127.0.0.1:8787)  --stdin/stdout-->  claude
```

Les réponses passent donc par ton **abonnement Claude Code** — aucune clé API n'est stockée dans Pluely.

---

## 1. Prérequis (une seule fois, sur Windows)

```powershell
npm install -g @anthropic-ai/claude-code
claude              # se connecter, puis quitter avec /exit
claude --version    # doit répondre
```

L'authentification est conservée dans `%USERPROFILE%\.claude`, le pont en hérite automatiquement.

Node.js doit également être accessible dans le `PATH` (c'est déjà le cas si tu as pu lancer `npm` ci-dessus).

---

## 2. Déclarer le provider dans Pluely

Rien à coder : **Dashboard → Dev Space → Add custom provider**.

**cURL :**

```
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "{{MODEL}}",
    "messages": [
      {"role": "system", "content": "{{SYSTEM_PROMPT}}"},
      {"role": "user", "content": [
        {"type": "text", "text": "{{TEXT}}"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,{{IMAGE}}"}}
      ]}
    ]
  }'
```

- **Streaming** : activé
- **Response content path** : `choices[0].message.content`

Puis, dans les settings du provider, renseigne la variable **`MODEL`** — par exemple `sonnet`, `opus` ou `haiku`. Aucune variable `API_KEY` n'est demandée.

---

## 3. Fonctionnement

Le pont est **lancé automatiquement** par Pluely au démarrage ([`src-tauri/src/bridge.rs`](../../src/bridge.rs)) et tué à la fermeture. Si le port 8787 répond déjà, Pluely réutilise l'instance existante au lieu d'en lancer une seconde.

À chaque requête, le pont lance `claude` en mode headless :

| Élément Pluely | Traduction |
|---|---|
| message `system` | `--system-prompt-file` (fichier temporaire) |
| historique | aplati en texte et préfixé à la question |
| question + screenshots | blocs JSON envoyés sur stdin (`--input-format stream-json`) |
| `model` | `--model` |

Le flux `stream-json` renvoyé est retraduit en SSE OpenAI. **Seuls les blocs de type `text` sont transmis** : le raisonnement (`thinking`) est filtré et n'apparaît jamais dans la réponse.

### Q&R pure

Tous les outils de Claude Code (`Bash`, `Read`, `Write`, `WebSearch`…) sont désactivés via `--disallowed-tools`, et les serveurs MCP sont neutralisés (`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`). Claude répond de mémoire, **sans aucun effet de bord sur ta machine** — mais lit bien les images, ce qui est l'essentiel pour Pluely (screenshot + question).

---

## 4. Lancer le pont à la main (debug)

```powershell
node server.mjs
```

Variables d'environnement disponibles :

| Variable | Défaut | Rôle |
|---|---|---|
| `PLUELY_BRIDGE_PORT` | `8787` | Port d'écoute |
| `PLUELY_CLAUDE_BIN` | `claude` | Chemin vers le binaire Claude Code |
| `PLUELY_CLAUDE_MODEL` | `sonnet` | Modèle par défaut si la requête n'en précise pas |
| `PLUELY_BRIDGE_TIMEOUT_MS` | `300000` | Délai max d'une requête |
| `PLUELY_BRIDGE_EXIT_ON_STDIN_CLOSE` | — | Mis à `1` par Pluely : le pont s'arrête si son parent meurt |

Tests rapides :

```powershell
curl http://127.0.0.1:8787/health

curl -N http://127.0.0.1:8787/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{\"model\":\"haiku\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"dis OK\"}]}'
```

---

## 5. Builder l'application Windows

Le dépôt vit sur ext4 côté WSL ; compiler à travers `\\wsl.localhost\…` est lent et instable. Copie-le vers un chemin Windows natif :

```powershell
git clone \\wsl.localhost\Ubuntu\home\wass\pluely C:\dev\pluely
cd C:\dev\pluely
npm ci
npm run tauri dev      # valider avant de builder
npm run tauri build
```

Artefacts produits :

- `src-tauri\target\release\bundle\msi\Pluely_*_x64_en-US.msi`
- `src-tauri\target\release\bundle\nsis\Pluely_*_x64-setup.exe`

---

## Limites connues

- **Sans état** : l'historique complet est renvoyé à chaque question, donc le cache de prompt de Claude Code est moins bien exploité entre les tours. Passer à `--resume` si le coût devient gênant.
- **Node.js requis** sur le `PATH`. Embarquer un binaire Node via `bundle.externalBin` supprimerait cette dépendance.
- **Port 8787 en dur** : en cas de conflit, il faut le changer à deux endroits — `BRIDGE_PORT` dans [`bridge.rs`](../../src/bridge.rs) et l'URL du provider dans Pluely.
- Les `image_url` distants (http://…) ne sont pas supportés, seulement les images en base64 — ce que Pluely envoie de toute façon.
