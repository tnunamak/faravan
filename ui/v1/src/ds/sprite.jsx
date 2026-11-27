import sprite from '../icons.svg?raw';

// Vite inlines the sprite into app.mjs. Kept apart from icon.jsx so tests need no bundler.
export function Sprite() {
  return <div hidden dangerouslySetInnerHTML={{__html: sprite}} />;
}
