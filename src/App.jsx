import React, { useCallback, useEffect, useRef, useState } from 'react';

const emptyDraft = () => ({ text: '', reasoning: '', tools: [], usage: null });

function statusDot(result, checking) {
  if (checking) return 'wait';
  if (!result) return 'unknown';
  return result.ok ? 'ok' : 'bad';
}

function VpnSelect({ modes, value, status, checking, onChange, onRefresh }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = (modes || []).find((m) => m.port === value);
  return (
    <div className="vpn-select" ref={ref}>
      <button type="button" className="vpn-trigger" onClick={() => setOpen(!open)}>
        <span className={'dot ' + statusDot(status?.[value], checking)} />
        <span className="vpn-value">{current?.name || 'VPN'}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="vpn-menu">
          <div className="vpn-menu-head">
            <span>подключения</span>
            <button type="button" onClick={onRefresh} disabled={checking}>
              {checking ? 'проверяю…' : 'проверить'}
            </button>
          </div>
          <div className="vpn-list">
            {(modes || []).map((m) => {
              const s = status?.[m.port];
              return (
                <button
                  type="button"
                  key={m.port}
                  className={'vpn-item' + (m.port === value ? ' active' : '')}
                  onClick={() => {
                    onChange(m.port);
                    setOpen(false);
                  }}
                >
                  <span className={'dot ' + statusDot(s, checking)} />
                  <span className="vpn-item-name">{m.name}</span>
                  <span className="vpn-item-meta">
                    {checking ? '…' : s ? (s.ok ? `${s.ms} мс` : 'нет связи') : '—'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSelect({ models, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = (models || []).filter(
    (m) => !q || String(m.id || '').toLowerCase().includes(q) || String(m.provider || '').toLowerCase().includes(q),
  );
  const groups = filtered.reduce((acc, m) => {
    const key = m.provider || 'jcode';
    (acc[key] ||= []).push(m);
    return acc;
  }, {});

  return (
    <div className="model-select" ref={ref}>
      <button type="button" className="model-trigger" onClick={() => setOpen(!open)}>
        <span className="model-value">{value || 'модель…'}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="model-menu">
          <input
            className="model-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="поиск модели…"
          />
          <div className="model-list">
            {Object.entries(groups).map(([provider, items]) => (
              <div className="model-group" key={provider}>
                <div className="model-group-title">{provider}</div>
                {items.map((m) => (
                  <button
                    type="button"
                    key={`${provider}/${m.id}`}
                    className={'model-item' + (m.id === value ? ' active' : '')}
                    onClick={() => {
                      onChange(m.id);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    {m.id}
                  </button>
                ))}
              </div>
            ))}
            {!filtered.length && <div className="model-empty">ничего не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [history, setHistory] = useState([]);
  const [draft, setDraft] = useState(emptyDraft());
  const [input, setInput] = useState('');
  const [models, setModels] = useState([]);
  const [currentModel, setCurrentModel] = useState('');
  const [permission, setPermission] = useState(null);
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [vpnModes, setVpnModes] = useState([]);
  const [vpnPort, setVpnPort] = useState(0);
  const [vpnStatus, setVpnStatus] = useState({});
  const [vpnChecking, setVpnChecking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const wsRef = useRef(null);
  const seq = useRef(0);
  const pending = useRef(new Map());
  const activeRef = useRef('');
  const chatRef = useRef(null);
  const stickRef = useRef(true);
  const taRef = useRef(null);

  const call = useCallback((cmd, args = {}) => {
    const id = ++seq.current;
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      wsRef.current?.send(JSON.stringify({ id, cmd, args }));
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await call('list_sessions');
      setSessions(Array.isArray(list) ? list : []);
    } catch (e) {
      setNotice(String(e.message || e));
    }
  }, [call]);

  const runVpnCheck = useCallback(async () => {
    setVpnChecking(true);
    try {
      const list = await call('vpn_check');
      const map = {};
      for (const item of list || []) map[item.port] = item;
      setVpnStatus(map);
    } catch (e) {
      setNotice(String(e.message || e));
    } finally {
      setVpnChecking(false);
    }
  }, [call]);

  const changeVpn = useCallback(
    async (port) => {
      setVpnPort(port);
      try {
        await call('vpn_set', { port });
        setNotice(`VPN: ${vpnModes.find((m) => m.port === port)?.name || port}`);
      } catch (e) {
        setNotice(String(e.message || e));
      }
    },
    [call, vpnModes],
  );

  const openSession = useCallback(
    async (id) => {
      if (!id) return;
      activeRef.current = id;
      setActiveId(id);
      setMenuOpen(false);
      setDraft(emptyDraft());
      setHistory([]);
      setPermission(null);
      stickRef.current = true;
      try {
        await call('attach', { sessionId: id });
        const h = await call('history', { sessionId: id });
        setHistory(Array.isArray(h) ? h : h?.messages || []);
        const m = await call('models', { sessionId: id });
        setModels(Array.isArray(m?.models) ? m.models : []);
        setCurrentModel(m?.current || '');
      } catch (e) {
        setNotice(String(e.message || e));
      }
    },
    [call],
  );

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      refreshSessions();
      call('vpn_modes')
        .then((r) => {
          setVpnModes(r?.modes || []);
          setVpnPort(r?.current || 0);
          runVpnCheck();
        })
        .catch(() => {});
    };
    ws.onclose = () => setNotice('connection lost — reload the page');
    ws.onerror = () => setNotice('websocket error');

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.current.has(msg.id)) {
        const p = pending.current.get(msg.id);
        pending.current.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'request failed'));
        return;
      }
      if (msg.type === 'sessions') {
        setSessions(msg.sessions || []);
        return;
      }
      if (msg.type === 'notice') {
        setNotice(msg.text);
        return;
      }
      if (msg.type === 'vpn') {
        setVpnPort(msg.port);
        return;
      }
      if (msg.type !== 'event') return;

      const ev = msg.event || {};
      const sid = ev.session_id || msg.sessionId;
      if (sid && activeRef.current && sid !== activeRef.current) return;

      switch (ev.ev) {
        case 'history':
          setHistory(ev.messages || []);
          break;
        case 'text_delta':
          setDraft((d) => ({ ...d, text: d.text + (ev.text || '') }));
          break;
        case 'reasoning_delta':
          setDraft((d) => ({ ...d, reasoning: d.reasoning + (ev.text || '') }));
          break;
        case 'tool_start':
          setDraft((d) => ({
            ...d,
            tools: [...d.tools, { id: ev.call_id, name: ev.name, status: 'running', output: '' }],
          }));
          break;
        case 'tool_done':
          setDraft((d) => ({
            ...d,
            tools: d.tools.map((t) =>
              t.id === ev.call_id
                ? { ...t, status: ev.error ? 'error' : 'done', output: ev.output || ev.error || '' }
                : t,
            ),
          }));
          break;
        case 'permission_request':
          setPermission({ requestId: ev.request_id, tool: ev.tool_name, description: ev.description });
          break;
        case 'token_usage':
          setDraft((d) => ({ ...d, usage: ev }));
          break;
        case 'model_info':
          if (ev.model) setCurrentModel(ev.model);
          break;
        case 'models':
          setModels((ev.models || []).map((m) => (typeof m === 'string' ? { id: m, provider: 'jcode' } : m)));
          setCurrentModel((c) => ev.current || c);
          break;
        case 'session_status':
          setStatus(ev.status || '');
          break;
        case 'turn_done':
          setDraft((d) => {
            if (d.text.trim() || d.reasoning.trim() || d.tools.length) {
              setHistory((h) => [
                ...h,
                { role: 'assistant', content: d.text, reasoning: d.reasoning, tools: d.tools, usage: d.usage },
              ]);
            }
            return emptyDraft();
          });
          setStatus('');
          break;
        case 'turn_stopped':
          setStatus(ev.message || ev.reason || '');
          setDraft(emptyDraft());
          break;
        default:
          break;
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [refreshSessions]);

  useEffect(() => {
    const el = chatRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [history, draft]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = 176;
    const h = Math.max(56, Math.min(el.scrollHeight, max));
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [input]);

  const send = async () => {
    const text = input.trim();
    if (!text || !activeId) return;
    setInput('');
    setHistory((h) => [...h, { role: 'user', content: text }]);
    setDraft(emptyDraft());
    try {
      await call('send', { sessionId: activeId, content: text });
    } catch (e) {
      setNotice(String(e.message || e));
    }
  };

  const newSession = async () => {
    try {
      setNotice('создаю сессию…');
      const s = await call('new_session', { workingDir: '/root' });
      const id = s?.session_id || s?.session?.session_id;
      if (!id) throw new Error('сервер не вернул id новой сессии');
      // Switch immediately, before any optional cleanup step can fail.
      activeRef.current = id;
      setActiveId(id);
      setMenuOpen(false);
      setHistory([]);
      setDraft(emptyDraft());
      stickRef.current = true;
      await call('attach', { sessionId: id });
      await refreshSessions();
      await openSession(id);
      setNotice(`новая сессия: ${id}`);
    } catch (e) {
      setNotice(`не удалось создать сессию: ${e.message || e}`);
    }
  };

  const decide = async (decision) => {
    if (!permission || !activeId) return;
    try {
      await call('permission', {
        sessionId: activeId,
        requestId: permission.requestId,
        decision,
      });
    } catch (e) {
      setNotice(String(e.message || e));
    }
    setPermission(null);
  };

  return (
    <div className="app">
      <div className={'overlay' + (menuOpen ? ' show' : '')} onClick={() => setMenuOpen(false)} />
      <aside className={'sidebar' + (menuOpen ? ' open' : '')}>
        <div className="brand">
          jcode<span>·web</span>
          <button className="close-menu" onClick={() => setMenuOpen(false)}>✕</button>
        </div>
        <button className="new" onClick={newSession}>+ новая сессия</button>
        <div className="sessions">
          {sessions.map((s) => (
            <button
              key={s.session_id}
              className={'session' + (s.session_id === activeId ? ' active' : '')}
              onClick={() => openSession(s.session_id)}
              title={s.working_dir || ''}
            >
              <span className="dot" />
              <span className="title">{s.title || s.session_id.replace('session_', '').slice(0, 18)}</span>
            </button>
          ))}
        </div>
        <div className="foot">
          {status && <div className="status">{status}</div>}
          {notice && <div className="notice">{notice}</div>}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="menu" onClick={() => setMenuOpen(!menuOpen)} title="сессии">
            ☰ <span className="menu-label">сессии</span>
          </button>
          <span className="cwd">{activeId || 'выберите сессию'}</span>
          <VpnSelect
            modes={vpnModes}
            value={vpnPort}
            status={vpnStatus}
            checking={vpnChecking}
            onChange={changeVpn}
            onRefresh={runVpnCheck}
          />
          <ModelSelect
            models={models}
            value={currentModel}
            onChange={(model) => {
              setCurrentModel(model);
              call('set_model', { sessionId: activeId, model }).catch((err) =>
                setNotice(String(err.message || err)),
              );
            }}
          />
          <button
            onClick={() => call('compact', { sessionId: activeId }).catch((e) => setNotice(String(e.message || e)))}
            title="сжать контекст"
          >
            сжать
          </button>
          <button onClick={() => call('cancel', { sessionId: activeId })} title="остановить">
            стоп
          </button>
        </header>

        <div
          className="chat"
          ref={chatRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {history.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="role">{m.role === 'user' ? 'вы' : m.role === 'assistant' ? 'агент' : m.role}</div>
              <div className="content">{m.content || ''}</div>
              {m.reasoning && <details className="thinking"><summary>размышление</summary><pre>{m.reasoning}</pre></details>}
              {m.tools?.length > 0 && (
                <div className="tools">
                  {m.tools.map((t, j) => (
                    <details key={j} className={'tool ' + t.status}>
                      <summary>{t.status === 'running' ? '⋯' : '✓'} {t.name}</summary>
                      <pre>{String(t.output).slice(0, 4000)}</pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          ))}

          {(draft.text || draft.reasoning || draft.tools.length > 0) && (
            <div className="msg assistant live">
              <div className="role">агент</div>
              {draft.reasoning && <details className="thinking" open><summary>размышление</summary><pre>{draft.reasoning}</pre></details>}
              {draft.tools.map((t, j) => (
                <details key={j} className={'tool ' + t.status} open>
                  <summary>{t.status === 'running' ? '⋯' : '✓'} {t.name}</summary>
                  <pre>{String(t.output).slice(0, 4000)}</pre>
                </details>
              ))}
              <div className="content">{draft.text || <span className="muted">…</span>}</div>
              {draft.usage && (
                <div className="usage">
                  in {draft.usage.input} · out {draft.usage.output} · cache {draft.usage.cache_read_input || 0}
                </div>
              )}
            </div>
          )}

          {permission && (
            <div className="permission">
              <div><b>Разрешение:</b> {permission.tool} — {permission.description}</div>
              <div className="row">
                <button onClick={() => decide('allow')}>разрешить</button>
                <button onClick={() => decide('allow_always')}>всегда</button>
                <button onClick={() => decide('deny')}>отклонить</button>
              </div>
            </div>
          )}

        </div>

        <div className="composer">
          <textarea
            ref={taRef}
            value={input}
            placeholder={activeId ? 'сообщение…' : 'сначала выберите сессию'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="send" onClick={send} disabled={!activeId || !input.trim()}>
            отправить
          </button>
        </div>
      </main>
    </div>
  );
}
