import type { GroupProductFilter } from './types';

/**
 * Shared Stream/Edge vocabulary — Cribl calls the same underlying concepts different things per
 * product ("Worker Group" containing "Workers" for Stream; "Fleet" containing "Nodes" for Edge).
 * `FleetRoster.tsx`/`AlertFeedPanel.tsx`/`KpiRow.tsx` already each keep their own local copy of
 * this exact mapping (`GROUP_COLUMN_LABEL`/`NODE_COLUMN_LABEL`-style records) — left as-is rather
 * than refactored onto this file, since they're already correct and this file exists to give every
 * *new* product-aware fix one canonical source instead of a fourth, fifth, sixth local copy. Keep
 * the literal strings here byte-for-byte identical to those existing copies.
 */
export const WORKER_NOUN: Record<GroupProductFilter, string> = { stream: 'Worker', edge: 'Node' };
export const WORKER_NOUN_PLURAL: Record<GroupProductFilter, string> = { stream: 'Workers', edge: 'Nodes' };
export const GROUP_NOUN: Record<GroupProductFilter, string> = { stream: 'Worker Group', edge: 'Fleet' };
