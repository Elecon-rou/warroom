import { createContext, useContext } from 'react';
import type { Kind, Source } from './types';
export const DataSourcesContext = createContext<Source[]>([]);
export const DataSourceScope = createContext<string | undefined>(undefined);
export const useDataSources = () => useContext(DataSourcesContext);
export function selectedSourceId(sources: Source[], kind: Kind, id?: string) {
  return id || sources.find((s) => s.kind === kind)?.id;
}
