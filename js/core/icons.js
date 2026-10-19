// The app's icons, one line-drawing set (24 × 24, drawn with the text colour; styled in theme.css as
// .ic). In templates: `${icon('generate')} Vary`. In static HTML: <span data-icon="play"></span>,
// filled in by fillIcons() (core/topbar.js runs it on every page).
const PATHS = {
  generate: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle class="f" cx="8.5" cy="8.5" r="1.6"/><circle class="f" cx="12" cy="12" r="1.6"/><circle class="f" cx="15.5" cy="15.5" r="1.6"/>',
  ai: '<path d="M11 3.5l1.9 5.3 5.3 1.9-5.3 1.9L11 17.9l-1.9-5.3-5.3-1.9 5.3-1.9z"/><path d="M18.5 15v5M16 17.5h5"/>',
  mutate: '<path d="M7 3c0 5 10 4 10 9s-10 4-10 9M17 3c0 5-10 4-10 9s10 4 10 9"/><path d="M9.3 6.5h5.4M9.3 17.5h5.4"/>',
  cross: '<circle cx="8.5" cy="12" r="5"/><circle cx="15.5" cy="12" r="5"/>',
  save: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  edit: '<path d="M4.5 19.5l1-4.5L16 4.5l3.5 3.5L9 18.5z"/><path d="M13.5 7l3.5 3.5"/>',
  bounce: '<path d="M3 7.5c1.5-4 3-4 4.5 0s3 4 4.5 0 3-4 4.5 0 3 4 4.5 0"/><path d="M12 11v7.5M8.5 15L12 18.5l3.5-3.5"/><path d="M5 21h14"/>',
  arm: '<circle cx="12" cy="12" r="8"/><circle class="f" cx="12" cy="12" r="3.5"/>',
  route: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
  play: '<path class="f" d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect class="f" x="6" y="6" width="12" height="12" rx="1"/>',
  rec: '<circle class="f" cx="12" cy="12" r="6.5"/>',
  power: '<path d="M12 3.5v8M7 6.5a7.5 7.5 0 1 0 10 0"/>',
  library: '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M15.5 5.2l3.8-1 3 15.5-3.8 1z"/>',
  knob: '<circle cx="12" cy="13" r="6.5"/><path d="M12 13l3-3.5"/><path d="M4 6l1.5 1.5M20 6l-1.5 1.5M12 2.5v2"/>',
  keys: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M8 5v14M12 5v14M16 5v14"/><path class="f" d="M6.5 5h3v8h-3zM14.5 5h3v8h-3z"/>',
  transfer: '<path d="M8 20V5M4.5 8.5L8 5l3.5 3.5M16 4v15M12.5 15.5L16 19l3.5-3.5"/>',
  spectro: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-3M11 16V8M14 16v-5M17 16V6"/>',
};

export const icon = (name, title = '') => `<svg class="ic ic-${name}" viewBox="0 0 24 24" aria-hidden="true"${title ? ` title="${title}"` : ''}>${PATHS[name] || ''}</svg>`;

export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]:empty')) el.outerHTML = icon(el.dataset.icon);
}
