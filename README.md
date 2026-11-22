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
| systemd | `jcode-proxy.service`, `jcode-bridge.service`, `jcode-web.service` |
| VPN | `/etc/vpn-modes.json` (список), `/root/.jcode/vpn-port` (выбранный порт, `0` = прямо) |
| nginx | `/etc/nginx/sites-enabled/code-fimdi.conf` → `127.0.0.1:8193` |

## Разработка

```bash
cd /root/forks/jcode-web
npm run dev            # Vite dev-сервер
npm run build          # собрать dist/ (164 КБ)
systemctl restart jcode-web
```

- `src/App.jsx` — весь UI (сессии, чат, стриминг, инструменты, разрешения).
- В списке сессий есть переименование (карандаш) и удаление (крестик). Удаление архивирует
  сессию в jcode и удаляет её файлы из `/root/.jcode/sessions`.
- Выбор модели — кастомный селект с поиском по названию модели и провайдеру.
- Поле ввода автоматически растёт до 176 px, дальше появляется скролл.
- «Новая сессия» (`new_session`): jcode переиспользует текущую сессию, если совпадают
  `working_dir` и system prompt. Поэтому для каждой новой сессии создаётся уникальная
  символическая ссылка `/root/.jcode-workspaces/<uuid>` → `/root`, и сессия стартует
  в ней. Системный промпт агента не меняется, файлы те же самые.
- `src/styles.css` — тема.
- `server.mjs` — WebSocket-протокол и список команд (`handleCommand`).

Протокол браузер↔мост: JSON по WebSocket `/ws`.
Запрос `{ id, cmd, args }`, ответ `{ id, ok, result }`, события `{ type: "event", sessionId, event }`.
Новая фича = новый `case` в `handleCommand` + вызов в `App.jsx`.

## Провайдеры моделей

Все провайдеры описаны в `/root/.jcode/config.toml` (бэкап — `config.toml.bak-before-free`).
Список в UI строится из `getRuntimeInfo().routes`, поэтому модели сгруппированы по провайдеру.

| Провайдер | Моделей | Ключ | Статус |
|---|---|---|---|
| `nanogpt` | 444 | `config/jcode/provider-nanogpt.env` | работает через `api.nano-gpt.com/v1` |
| `opencode-free` | 83 | нет (keyless) | `429 FreeUsageLimitError` — лимит бесплатного тира |
| `opencode-go` | 37 | `config/jcode/provider-opencode-go.env` (из старого `pi/auth.json`) + `EnvironmentFile` в юните | `429 GoUsageLimitError`, сброс через ~3 дня; нужен заголовок `x-opencode-session` (прописан) |
| `llm7` | 2 | нет (keyless) | отвечает на маленькие запросы, но таймаутит на промпте агента ~33 КБ |

`opencode-free` модели берутся из публичного `GET https://opencode.ai/inference/v1/models`
(фильтр: `type=chat` + tool calling), `opencode-go` — из `GET /zen/go/v1/models` с ключом.
Чтобы обновить список, измените `config.toml` и перезапустите `jcode-bridge`.

Остальные бесплатные шлюзы из pi-free (cline, fastrouter, agnes, tokenrouter, opengateway)
сейчас требуют ключ или платёж, поэтому в конфиг не добавлены.

## VPN

jcode не умеет работать с `socks5://user:pass@…`, поэтому между ним и провайдером стоит
локальный CONNECT-прокси `proxy.mjs` (`127.0.0.1:8118`). Он читает выбранный порт из
`/root/.jcode/vpn-port` и для каждого соединения либо идёт напрямую (`0`), либо через
соответствующий socks5-инбаунд xray (`user:12345`).

В UI список режимов берётся из `/etc/vpn-modes.json`, выбор сохраняется командой `vpn_set`.
Переключение не требует рестарта сервисов — следующий запрос уже пойдёт через новый канал.

Каждый режим можно проверить **не переключаясь на него**: `vpn_check` запрашивает
`POST /check` у `proxy.mjs`, который делает TLS-handshake и HEAD-запрос к
`api.nano-gpt.com` через конкретный socks5-инбаунд. В списке у каждого пункта
показывается зелёный/красный индикатор и задержка; кнопка «проверить» обновляет их.

По последней проверке работают `0` (прямо), `1082`, `1083`, `1085`, `1086`; остальные
не проходят для `api.nano-gpt.com` — это состояние самих VPN-эндпоинтов, а не UI.

## Телефон

Сайт адаптивен: сайдбар превращается в выдвижное меню по кнопке «☰ сессии» (она видна
и на узких экранах, и при `pointer: coarse`, то есть если телефон запрашивает desktop-версию).
Добавлены `100dvh` и `env(safe-area-inset-*)` — шапка не прячется под вырезом/статус-баром.
Элементы управления крупнее, поле ввода не масштабируется (font-size 16px).
Выбор VPN и его проверка доступны в шапке.

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
