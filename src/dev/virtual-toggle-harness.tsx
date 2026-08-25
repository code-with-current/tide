/** Debug harness (temporary): reproduces compact-mode toggle behavior of the
 *  chat timeline against the REAL VirtualizedMessageList, with mock
 *  rows shaped like renderStaticTurnContent's collapsed/expanded branches.
 *  Mounted by harness-virtual.html at the vite dev server root. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualizedMessageList, type TimelineRow } from '@/components/chat/timeline/virtualized-message-list';

type TurnRow = Extract<TimelineRow, { kind: 'turn' }>;

const ROW_COUNT = 10;

function App() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [log, setLog] = useState<string[]>([]);

  const rows = useMemo<TimelineRow[]>(
    () => Array.from({ length: ROW_COUNT }, (_, i): TurnRow => ({
      key: `turn:t${i}`,
      kind: 'turn',
      turn: { turnId: `t${i}` } as TurnRow['turn'],
      userMessage: true,
    })),
    [],
  );

  const appendLog = useCallback((entry: string) => {
    setLog((prev) => [...prev.slice(-40), `${new Date().toISOString().slice(11, 23)} ${entry}`]);
  }, []);

  const renderRowContent = useCallback((row: TimelineRow) => {
    if (row.kind !== 'turn') return null;
    const isExpandedRow = !!expanded[row.key];
    const toggle = () => {
      appendLog(`TOGGLE ${row.key} -> ${!isExpandedRow ? 'expand' : 'collapse'} scrollTop=${scrollRef.current?.scrollTop}`);
      setExpanded((s) => ({ ...s, [row.key]: !s[row.key] }));
    };
    if (!isExpandedRow) {
      return (
        <>
          <div style={{ height: 64, background: '#dbeafe' }}>user msg {row.key}</div>
          <button type="button" data-testid={`toggle-${row.key}`} onClick={toggle}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: 4 }}>
            ▸ summary {row.key}
          </button>
          <div style={{ height: 96, background: '#dcfce7' }}>result {row.key}</div>
        </>
      );
    }
    return (
      <>
        <button type="button" data-testid={`toggle-${row.key}`} onClick={toggle}
          style={{ display: 'block', width: '100%', textAlign: 'left', padding: 4 }}>
          ▾ summary {row.key}
        </button>
        <div style={{ height: 900, background: '#fef9c3' }}>
          FULL TURN {row.key} — tall expanded content
        </div>
      </>
    );
  }, [expanded, appendLog]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const el = scrollRef.current;
      if (!el) return;
      const sizeContainer = el.querySelector(':scope > div') as HTMLElement | null;
      appendLog(`SCROLL scrollTop=${Math.round(el.scrollTop)} scrollHeight=${el.scrollHeight} clientHeight=${el.clientHeight} sizeContainerH=${sizeContainer ? Math.round(sizeContainer.getBoundingClientRect().height) : '?'}`);
    }, 500);
    return () => window.clearInterval(id);
  }, [appendLog]);

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ flex: 1, position: 'relative', borderRight: '2px solid #888' }}>
        <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto', overflowAnchor: 'none', padding: 12, boxSizing: 'border-box' }}>
          <VirtualizedMessageList
            sessionKey="harness"
            rows={rows}
            scrollRef={scrollRef}
            renderRowContent={renderRowContent}
          />
          <div style={{ height: 24 }} />
        </div>
      </div>
      <pre id="metrics" style={{ width: 420, fontSize: 11, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' }}>
        {log.join('\n')}
      </pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
