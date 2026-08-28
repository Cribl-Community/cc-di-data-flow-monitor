import { useEffect, useRef, useState } from 'react';
import { Text, TextField, NumberField, Button, Spinner } from '@capra/core';
import { startCapture, type CapturedEvent } from '../api/capture';
import { CAPTURE_LEVEL_LABEL, type CaptureLevel, type GroupProductFilter } from '../lib/types';
import { GROUP_NOUN } from '../lib/productTerms';
import './CapturePanel.css';

export function CapturePanel({
  groupId,
  level,
  contextLabel,
  defaultFilter,
  product = 'stream',
}: {
  groupId: string;
  level: CaptureLevel;
  contextLabel: string;
  /** Auto-built from known Source relationships for this checkpoint — see `upstreamSourceInputKeys`. */
  defaultFilter?: string;
  /** This checkpoint's own real product ('stream'/'edge'), resolved by `SignalPathPage.tsx` from
   *  `groupProductById` — picks "Worker Group"/"Fleet" in the explanatory text below. Cribl's
   *  Capture API applies uniformly to Edge Fleets (this app's own Signal Path/Flow Explorer
   *  topology model already applies to Edge with no shape changes needed), so this is purely a
   *  wording fix, not a capability gate. Defaults to `'stream'` when omitted. */
  product?: GroupProductFilter;
}) {
  const [filter, setFilter] = useState(defaultFilter ?? '');
  const [duration, setDuration] = useState(5);
  const [maxEvents, setMaxEvents] = useState(50);
  const [events, setEvents] = useState<CapturedEvent[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // Reset when the target checkpoint changes (a different capture icon was clicked) — including
  // re-seeding the filter with the new location's auto-built default, not carrying over the
  // previous location's filter (or a since-cleared one).
  useEffect(() => {
    abortRef.current?.abort();
    setEvents([]);
    setStatus('idle');
    setError(undefined);
    setFilter(defaultFilter ?? '');
  }, [groupId, level, contextLabel, defaultFilter]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = () => {
    setEvents([]);
    setStatus('running');
    setError(undefined);
    const controller = new AbortController();
    abortRef.current = controller;

    startCapture(
      { groupId, level, filter: filter.trim() || undefined, duration, maxEvents },
      (event) => setEvents((prev) => (prev.length >= maxEvents ? prev : [...prev, event])),
      controller.signal,
    )
      .then(() => setStatus('done'))
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          setStatus('done');
          return;
        }
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const stop = () => abortRef.current?.abort();

  return (
    <div className="capture-panel">
      <Text as="p" variant="body-sm-normal" color="subtle">
        Capturing <b>{CAPTURE_LEVEL_LABEL[level]}</b>, near <b>{contextLabel}</b>. The Capture API samples live
        traffic at this checkpoint across the whole {GROUP_NOUN[product]}, not just this path — {defaultFilter
          ? 'so the filter below is pre-filled with the Sources known to reach this location. Adjust or clear it to broaden the capture.'
          : 'add a filter expression below to narrow it to a specific path.'}
      </Text>

      <TextField
        label="Filter expression (optional)"
        value={filter}
        onChange={setFilter}
        helperText="JavaScript expression evaluated per event, e.g. sourcetype=='syslog'"
      />

      <div className="capture-panel-row">
        <NumberField label="Duration (sec)" value={duration} onChange={setDuration} min={1} max={60} />
        <NumberField label="Max events" value={maxEvents} onChange={setMaxEvents} min={1} max={1000} />
      </div>

      <div className="capture-panel-actions">
        {status === 'running' ? (
          <Button appearance="danger" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button appearance="default" onClick={start}>
            {status === 'idle' ? 'Start capture' : 'Capture again'}
          </Button>
        )}
        {status === 'running' && <Spinner size="sm" />}
        <Text as="span" variant="body-xs-normal" color="subtle">
          {events.length} event{events.length === 1 ? '' : 's'} captured
        </Text>
      </div>

      {error && (
        <Text as="p" variant="body-sm-normal" color="attention">
          {error}
        </Text>
      )}

      <div className="capture-events">
        {events.map((event, i) => (
          <pre key={i} className="capture-event">
            {event._raw ?? JSON.stringify(event)}
          </pre>
        ))}
        {status === 'idle' && events.length === 0 && (
          <Text as="p" variant="body-sm-normal" color="subtle">
            No capture running yet.
          </Text>
        )}
      </div>
    </div>
  );
}
