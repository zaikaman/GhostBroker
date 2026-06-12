import React, { createContext, useContext, useState, useEffect } from 'react';

export type RoutePath = '/' | '/dashboard' | '/settings';

interface RouterContextType {
  currentPath: string;
  navigate: (path: RoutePath) => void;
}

const RouterContext = createContext<RouterContextType | undefined>(undefined);

export function useRouter(): RouterContextType {
  const context = useContext(RouterContext);
  if (!context) {
    throw new Error('useRouter must be used within a RouterProvider');
  }
  return context;
}

interface RouterProviderProps {
  children: React.ReactNode;
}

export function RouterProvider({ children }: RouterProviderProps): React.JSX.Element {
  // Use hash-based routing for reliability and simplicity in dev and production
  const [currentPath, setCurrentPath] = useState<string>(() => {
    const hash = window.location.hash;
    if (!hash) return '/';
    return hash.replace(/^#/, '') || '/';
  });

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      setCurrentPath(hash.replace(/^#/, '') || '/');
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigate = (path: RoutePath) => {
    window.location.hash = path === '/' ? '' : path;
    setCurrentPath(path);
  };

  return (
    <RouterContext.Provider value={{ currentPath, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

interface RouteProps {
  path: RoutePath;
  element: React.ReactNode;
}

export function Route({ path, element }: RouteProps): React.JSX.Element | null {
  const { currentPath } = useRouter();

  const isMatch = currentPath === path;

  if (!isMatch) return null;

  return <>{element}</>;
}

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  to: RoutePath;
  children: React.ReactNode;
}

export function Link({ to, children, className, ...props }: LinkProps): React.JSX.Element {
  const { navigate } = useRouter();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate(to);
  };

  return (
    <a href={`#${to}`} onClick={handleClick} className={className} {...props}>
      {children}
    </a>
  );
}
