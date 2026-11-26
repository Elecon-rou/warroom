import {
  Activity,
  AlignLeft,
  GitBranch,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from 'lucide-react';
import type { Kind, ResponseData } from './types';

export const sourceMetadata = {
  metrics: { name: 'Metrics', language: 'PromQL / MetricsQL', icon: Activity },
  logs: { name: 'Logs', language: 'LogsQL', icon: AlignLeft },
  traces: { name: 'Traces', language: 'Jaeger search', icon: GitBranch },
};
export const sourceKinds: Kind[] = ['metrics', 'logs', 'traces'];
export const inputModes = [
  { value: 'manual' as const, label: 'Manual', icon: Terminal },
  { value: 'constructor' as const, label: 'Constructor', icon: SlidersHorizontal },
  { value: 'llm' as const, label: 'LLM', icon: Sparkles },
];
export type HistoryEntry = { kind: Kind; sourceId?: string; query: string; at: number };
export type Generation = {
  pending: boolean;
  verdict?: 'PASS' | 'FAIL';
  error?: string;
  discovery?: { tool: string; elapsedMs: number; error?: string }[];
};
export type LLMConfig = { configured: boolean; model: string; provider?: string };
export type QueryOutput = {
  response?: ResponseData;
  error?: string;
  pending: boolean;
  text: string;
};
export const queryName = (index: number) => String.fromCharCode(65 + index);
