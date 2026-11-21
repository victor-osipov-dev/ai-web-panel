# jcode-web

Минимальный веб-UI для [jcode](https://github.com/1jehuang/jcode) поверх SDK v1.

## Архитектура

```
браузер
  → nginx code.fimdi.ru (basic auth, WebSocket upgrade)
  → Node-мост 127.0.0.1:8193   (этот репозиторий, server.mjs)
  → @1jehuang/jcode-sdk → /run/user/0/jcode-api.sock
  → jcode api-bridge → jcode daemon
  → NanoGPT (https://api.nano-gpt.com/v1)
```

Память на сервере (замер): `jcode-bridge` + daemon ≈ 113 MB, Node-мост ≈ 21 MB.
Старый `pi-web` + `pi` занимали 380–500 MB.

## Пути

| Что | Где |
|---|---|
| Исходники UI | `/root/forks/jcode-web` |
| jcode (бинарник v1.0.1) | `/opt/jcode/jcode` → `/usr/local/bin/jcode` |
| Состояние и конфиг jcode | `/root/.jcode` |
| Провайдер NanoGPT | `/root/.jcode/config.toml`, ключ в `config/jcode/provider-nanogpt.env` |
| systemd | `jcode-bridge.service`, `jcode-web.service` |
| nginx | `/etc/nginx/sites-enabled/code-fimdi.conf` → `127.0.0.1:8193` |

## Разработка

```bash
cd /root/forks/jcode-web
npm run dev            # Vite dev-сервер
npm run build          # собрать dist/ (164 КБ)
systemctl restart jcode-web
```

- `src/App.jsx` — весь UI (сессии, чат, стриминг, инструменты, разрешения, модель).
- `src/styles.css` — тема.
- `server.mjs` — WebSocket-протокол и список команд (`handleCommand`).

Протокол браузер↔мост: JSON по WebSocket `/ws`.
Запрос `{ id, cmd, args }`, ответ `{ id, ok, result }`, события `{ type: "event", sessionId, event }`.
Новая фича = новый `case` в `handleCommand` + вызов в `App.jsx`.

## Эксплуатация

```bash
systemctl status jcode-bridge jcode-web
journalctl -u jcode-web -f
```

Откат на pi-web:

```bash
systemctl stop jcode-web jcode-bridge
sed -i 's|127.0.0.1:8193|127.0.0.1:8192|' /etc/nginx/sites-enabled/code-fimdi.conf
systemctl reload nginx
systemctl enable --now pi-web
```
