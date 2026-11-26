import type { Kind, ResponseData } from './types';

export type DiscoveryCall = { tool: string; elapsedMs: number; error?: string };
export type InvestigationWidget = {
  id: string;
  kind: Kind;
  sourceId?: string;
  title: string;
  query: string;
  start: number;
  end: number;
  limit: number;
  response?: ResponseData;
  truncated: boolean;
};
export type InvestigationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  widgets?: InvestigationWidget[];
  discovery?: DiscoveryCall[];
  skills?: string[];
  context?: string;
  verdict?: string;
  error?: boolean;
  incomplete?: boolean;
  warning?: string;
};
export const investigationStorageKey = 'warroom.investigate.v1';
export function restoreConversation(): InvestigationMessage[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(investigationStorageKey) || '[]');
    return Array.isArray(value)
      ? value
          .filter(
            (m) =>
              typeof m.id === 'string' &&
              ['user', 'assistant'].includes(m.role) &&
              typeof m.content === 'string',
          )
          .slice(-40)
      : [];
  } catch {
    return [];
  }
}
export function buildConversationContext(
  messages: InvestigationMessage[],
): { role: string; content: string }[] {
  // Rejected or failed turns do not become context for the next investigation.
  const accepted: InvestigationMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (
      m.role === 'user' &&
      messages[i + 1]?.role === 'assistant' &&
      (messages[i + 1].verdict === 'FAIL' || messages[i + 1].error)
    ) {
      i++;
      continue;
    }
    if (!m.error && m.verdict !== 'FAIL') accepted.push(m);
  }
  const history = accepted.slice(-10).map((m) => ({
    role: m.role,
    content: (
      (m.incomplete
        ? 'The previous investigation was incomplete; its conclusion was not verified.'
        : m.content) + (m.context ? `\nPrior widget evidence: ${m.context}` : '')
    ).slice(0, 14000),
  }));
  // Keep compact widget evidence while staying below the server request limit.
  while (history.length > 1 && new TextEncoder().encode(JSON.stringify(history)).length > 90000)
    history.shift();
  while (history.length > 1 && history[0].role === 'assistant') history.shift();
  return history;
}
