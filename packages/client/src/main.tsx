/**
 * Client entry: environment gates (WebGL2, desktop) then the React shell.
 * The in-world game itself is not React — see src/game/run-world.ts.
 */

import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';

const app = document.getElementById('app');
if (!app) throw new Error('#app container missing from index.html');

const supportsWebGL2 = (): boolean => {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
};

const gate = (title: string, text: string): void => {
  app.innerHTML = `
    <div class="overlay">
      <div>
        <div class="overlay-title">${title}</div>
        <div class="overlay-text">${text}</div>
      </div>
    </div>`;
};

if (!supportsWebGL2()) {
  gate(
    'WebGL2 required',
    'Dawned needs a browser with WebGL2 — try a recent Chrome, Firefox or Safari on desktop.',
  );
} else if (window.innerWidth < 900) {
  gate(
    'Desktop only',
    'Dawned is built desktop-first (1080p and 1440p). Mobile support is not planned for 0.1.0.',
  );
} else {
  createRoot(app).render(<App />);
}
