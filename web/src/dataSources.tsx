import { createContext, useContext } from 'react';
import type { Source } from './types';
export { selectedSourceId, sourceName } from './sourceSelection';
export const DataSourcesContext = createContext<Source[]>([]);
export const DataSourceScope = createContext<string | undefined>(undefined);
export const useDataSources = () => useContext(DataSourcesContext);
