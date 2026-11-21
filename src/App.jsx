import React, { useCallback, useEffect, useRef, useState } from 'react';

const emptyDraft = () => ({ text: '', reasoning: '', tools: [], usage: null });

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
  const [menuOpen, setMenuOpen] = useState(false);

  const wsRef = useRef(null);
  const seq = useRef(0);
  const pending = useRef(new Map());
  const activeRef = useRef('');
  const bottomRef = useRef(null);

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

  const openSession = useCallback(
    async (id) => {
      if (!id) return;
      activeRef.current = id;
      setActiveId(id);
      setMenuOpen(false);
      setDraft(emptyDraft());
      setHistory([]);
      setPermission(null);
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, draft]);

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
      const s = await call('create_session', { workingDir: '/root' });
      await refreshSessions();
      await openSession(s.session_id);
    } catch (e) {
      setNotice(String(e.message || e));
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
          <button className="menu" onClick={() => setMenuOpen(!menuOpen)} title="сессии">☰</button>
          <span className="cwd">{activeId || 'выберите сессию'}</span>
          <label className="vpn">
            <span>VPN</span>
            <select
              value={vpnPort}
              onChange={async (e) => {
                const port = Number(e.target.value);
                setVpnPort(port);
                try {
                  await call('vpn_set', { port });
                  setNotice(`VPN: ${vpnModes.find((m) => m.port === port)?.name || port}`);
                } catch (err) {
                  setNotice(String(err.message || err));
                }
              }}
            >
              {vpnModes.map((m) => (
                <option key={m.port} value={m.port}>{m.name}</option>
              ))}
            </select>
          </label>
          <select
            value={currentModel}
            onChange={(e) => {
              setCurrentModel(e.target.value);
              call('set_model', { sessionId: activeId, model: e.target.value }).catch((err) =>
                setNotice(String(err.message || err)),
              );
            }}
          >
            {!currentModel && <option value="">модель…</option>}
            {Object.entries(
              models.reduce((acc, m) => {
                const key = m?.provider || 'jcode';
                (acc[key] ||= []).push(m);
                return acc;
              }, {}),
            ).map(([provider, items]) => (
              <optgroup key={provider} label={provider}>
                {items.map((m) => (
                  <option key={`${provider}/${m.id}`} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
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

        <div className="chat">
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
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <textarea
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
