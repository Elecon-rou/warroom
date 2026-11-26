import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  Clock3,
  LoaderCircle,
  RotateCcw,
  Square,
  LayoutDashboard,
  Bell,
} from 'lucide-react';
import { restoreInvestigationChatID, newInvestigationChatID } from './investigationChat';
import { useInvestigationExport } from './useInvestigationExport';
import { InvestigationExportPreview } from './InvestigationExportPreview';
import { buildExportContext } from './investigationExport';
import type { Dashboard } from './dashboard';
import { ChatWidgetView } from './ChatWidget';
import { ranges, localDateTime, inputDateTime, type InvestigateSettings } from './state';
import {
  investigationStorageKey,
  restoreConversation,
  buildConversationContext,
  type InvestigationMessage,
} from './investigation';
type ChatTextProps = { text: string };

function ChatText({ text }: ChatTextProps) {
  return (
    <div className="chat-text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
type InvestigateViewProps = {
  settings: InvestigateSettings;
  onChange: (settings: InvestigateSettings) => void;
  onDashboard: (dashboard: Dashboard) => void;
};

export function InvestigateView({ settings, onChange, onDashboard }: InvestigateViewProps) {
  const [messages, setMessages] = useState<InvestigationMessage[]>(restoreConversation);
  const [chatId, setChatId] = useState(restoreInvestigationChatID);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const contextExport = useInvestigationExport(messages, chatId);
  const hasExportContext = buildExportContext(messages).messages.length > 0;
  function selectedWindow() {
    const end =
      settings.range === 'custom' ? Date.parse(settings.customEnd) / 1000 : Date.now() / 1000;
    const start =
      settings.range === 'custom'
        ? Date.parse(settings.customStart) / 1000
        : end - Number(ranges.find((r) => r[0] === settings.range)?.[2] || 3600);
    return { start, end };
  }
  function resetChat() {
    controller.current?.abort();
    controller.current = null;
    contextExport.clear();
    setChatId(newInvestigationChatID());
    setMessages([]);
    setInput('');
    setError('');
    setPending(false);
  }
  const controller = useRef<AbortController | null>(null);
  const tail = useRef<HTMLDivElement | null>(null);
  function update(patch: Partial<InvestigateSettings>) {
    onChange({ ...settings, ...patch });
  }
  // Persist widget queries, not potentially large telemetry response bodies.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        investigationStorageKey,
        JSON.stringify(
          messages.map((m) => ({
            ...m,
            widgets: m.widgets?.map(({ response, ...widget }) => widget),
          })),
        ),
      );
    } catch {}
  }, [messages]);
  useEffect(() => {
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length, pending]);
  async function send() {
    if (pending || contextExport.pending || !input.trim()) return;
    const text = input.trim();
    if (new TextEncoder().encode(text).length > 8000) {
      setError('Message limit is 8000 bytes.');
      return;
    }
    const user: InvestigationMessage = { id: crypto.randomUUID(), role: 'user', content: text };
    const history = [...messages, user];
    setMessages(history);
    setInput('');
    setError('');
    setPending(true);
    const abortController = new AbortController();
    controller.current = abortController;
    const end =
      settings.range === 'custom' ? Date.parse(settings.customEnd) / 1000 : Date.now() / 1000;
    const start =
      settings.range === 'custom'
        ? Date.parse(settings.customStart) / 1000
        : end - Number(ranges.find((r) => r[0] === settings.range)?.[2] || 3600);
    try {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        throw new Error('Invalid time range.');
      const response = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: buildConversationContext(history), chatId, start, end }),
        signal: abortController.signal,
      });
      const result = await response.json();
      if (controller.current !== abortController) return;
      setMessages((old) => [
        ...old,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.ok ? result.message : result.error || 'Investigation failed.',
          widgets: result.widgets || [],
          skills: result.skills || [],
          discovery: result.discovery || [],
          context: result.context,
          incomplete: !!result.incomplete,
          warning: result.warning,
          verdict: result.verdict,
          error: !response.ok && result.verdict !== 'FAIL',
        },
      ]);
    } catch (err) {
      if (controller.current === abortController) {
        if ((err as Error).name === 'AbortError') setError('Investigation cancelled.');
        else {
          const content = (err as Error).message;
          setMessages((old) => [
            ...old,
            { id: crypto.randomUUID(), role: 'assistant', content, error: true },
          ]);
        }
      }
    } finally {
      if (controller.current === abortController) {
        setPending(false);
        controller.current = null;
      }
    }
  }
  return (
    <main className="explore investigate-page">
      <div className="page-heading">
        <h1>
          Investigate<span className="heading-dot">.</span>
        </h1>
      </div>
      <div className="investigate-controls">
        <div className="range-selector">
          <Clock3 size={14} />
          <select
            aria-label="Investigation time range"
            value={settings.range}
            onChange={(e) => update({ range: e.target.value })}
          >
            {ranges.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
            <option value="custom">Custom range</option>
          </select>
        </div>
        <div className="investigation-context-actions">
          <button
            className="subtle-button"
            disabled={pending || contextExport.pending || !hasExportContext}
            onClick={() => {
              const { start, end } = selectedWindow();
              void contextExport.generate('dashboard', start, end);
            }}
          >
            <LayoutDashboard size={14} />
            Export to dashboard
          </button>
          <button
            className="subtle-button"
            disabled={pending || contextExport.pending || !hasExportContext}
            onClick={() => {
              const { start, end } = selectedWindow();
              void contextExport.generate('vmalert', start, end);
            }}
          >
            <Bell size={14} />
            Export to vmalert
          </button>
          <button
            className="subtle-button"
            disabled={
              !messages.length &&
              !pending &&
              !contextExport.draft &&
              !contextExport.pending &&
              !input
            }
            onClick={resetChat}
          >
            <RotateCcw size={14} />
            Reset chat
          </button>
        </div>
        {contextExport.pending && (
          <div className="investigation-export-status" role="status">
            <LoaderCircle size={14} className="spin" />
            {contextExport.phase}
            <button className="subtle-button" onClick={contextExport.cancel}>
              Cancel export
            </button>
          </div>
        )}
      </div>
      {settings.range === 'custom' && (
        <div className="custom-range">
          <label>
            From
            <input
              type="datetime-local"
              aria-label="Investigation range start"
              value={localDateTime(settings.customStart)}
              onChange={(e) => update({ customStart: inputDateTime(e.target.value) })}
            />
          </label>
          <label>
            To
            <input
              type="datetime-local"
              aria-label="Investigation range end"
              value={localDateTime(settings.customEnd)}
              onChange={(e) => update({ customEnd: inputDateTime(e.target.value) })}
            />
          </label>
        </div>
      )}
      {contextExport.error && (
        <p className="inline-error" role="status">
          {contextExport.error}
        </p>
      )}
      {contextExport.draft && (
        <InvestigationExportPreview
          draft={contextExport.draft}
          onClose={contextExport.clear}
          onDashboard={onDashboard}
        />
      )}
      <div
        className="chat-messages"
        role="log"
        aria-label="Investigation conversation"
        aria-live="polite"
      >
        {messages.map((message) => (
          <article
            className={`chat-message ${message.role} ${message.verdict === 'FAIL' ? 'rejected' : ''}`}
            key={message.id}
          >
            <div className="chat-message-heading">
              <span>{message.role === 'user' ? 'You' : 'Investigate'}</span>
              {message.verdict && (
                <span className={`verdict ${message.verdict.toLowerCase()}`}>
                  {message.verdict}
                </span>
              )}
              {message.skills?.map((skill) => (
                <span className="skill-tag" key={skill}>
                  {skill}
                </span>
              ))}
            </div>
            {message.warning && (
              <p className="investigation-warning" role="status">
                {message.warning}
              </p>
            )}
            <ChatText text={message.content} />
            {message.widgets?.map((widget) => (
              <ChatWidgetView key={widget.id} widget={widget} />
            ))}
            {!!message.discovery?.length && (
              <details className="discovery-log">
                <summary>Tools & skills · {message.discovery.length} calls</summary>
                <ul>
                  {message.discovery.map((call, index) => (
                    <li key={index}>
                      <code>{call.tool}</code>
                      <span>{call.elapsedMs} ms</span>
                      {call.error && <p>{call.error}</p>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
        {pending && (
          <div className="chat-pending" role="status">
            <LoaderCircle size={15} className="spin" />
            Investigating…
          </div>
        )}
        <div ref={tail} />
      </div>
      {error && (
        <p className="inline-error" role="status">
          {error}
        </p>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Investigation message"
          maxLength={8000}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
              const textarea = e.currentTarget;
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              setInput(input.slice(0, start) + '\n' + input.slice(end));
              requestAnimationFrame(() => textarea.setSelectionRange(start + 1, start + 1));
            } else {
              void send();
            }
          }}
        />
        <div className="chat-composer-footer">
          <span>Infrastructure · business · issues</span>
          <button
            className="run-button"
            aria-label={pending ? 'Cancel investigation' : 'Send investigation message'}
            type={pending ? 'button' : 'submit'}
            disabled={contextExport.pending || (!pending && !input.trim())}
            onClick={pending ? () => controller.current?.abort() : undefined}
          >
            {pending ? <Square size={14} /> : <ArrowUp size={15} />} {pending ? 'Cancel' : 'Send'}
          </button>
        </div>
      </form>
    </main>
  );
}
