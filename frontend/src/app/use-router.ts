import { createContext, useContext } from 'react';

/**
 * The set of route paths the app knows about. Kept narrow (a union)
 * so TypeScript catches typos at the call site.
 */
export type RoutePath = '/' | '/dashboard' | '/settings' | '/auth' | '/deploy';

export interface RouterContextType {
  currentPath: string;
  navigate: (path: RoutePath) => void;
}

export const RouterContext = createContext<RouterContextType | undefined>(undefined);

/**
 * Subscribe to the current route. Must be used inside a
 * {@link RouterProvider}; the context throws if accessed outside.
 */
export function useRouter(): RouterContextType {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouter must be used within a RouterProvider');
  }
  return context;
}
