import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Failed to find the root element. Ensure index.html has a div with id="root".');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
