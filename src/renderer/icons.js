'use strict';
// Small stroke icon set (16px grid, 1.5 stroke). Drawn for this app; no external assets.
(function () {
  const svg = (body, size = 16, extra = '') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${body}</svg>`;
  const fill = (body, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${body}</svg>`;

  window.BCS = window.BCS || {};
  window.BCS.icons = {
    play: (s = 18) => fill('<path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.7-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z"/>', s),
    pause: (s = 18) => fill('<rect x="3.6" y="2.8" width="3" height="10.4" rx=".8"/><rect x="9.4" y="2.8" width="3" height="10.4" rx=".8"/>', s),
    frameBack: (s = 16) => svg('<path d="M10 3.5 5.5 8l4.5 4.5"/><path d="M3 3.5v9"/>', s),
    frameFwd: (s = 16) => svg('<path d="M6 3.5 10.5 8 6 12.5"/><path d="M13 3.5v9"/>', s),
    grid: (s = 16) => svg('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>', s),
    focus: (s = 16) => svg('<rect x="2.5" y="2.5" width="11" height="7" rx="1.2"/><rect x="2.5" y="11.2" width="3.2" height="2.3" rx=".7"/><rect x="6.4" y="11.2" width="3.2" height="2.3" rx=".7"/><rect x="10.3" y="11.2" width="3.2" height="2.3" rx=".7"/>', s),
    speaker: (s = 16) => svg('<path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z" fill="currentColor"/><path d="M10.4 5.7a3.4 3.4 0 0 1 0 4.6"/><path d="M12.2 4a5.8 5.8 0 0 1 0 8"/>', s),
    speakerLow: (s = 16) => svg('<path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z" fill="currentColor"/><path d="M10.4 5.7a3.4 3.4 0 0 1 0 4.6"/>', s),
    mute: (s = 16) => svg('<path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z" fill="currentColor"/><path d="m10.6 6 3 4M13.6 6l-3 4"/>', s),
    eye: (s = 16) => svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>', s),
    eyeOff: (s = 16) => svg('<path d="M2.2 8.6C3.3 10.4 5.4 12.5 8 12.5c.9 0 1.7-.2 2.4-.6M13.4 10.3c.7-.8 1.1-1.5 1.1-2.3 0 0-2.5-4.5-6.5-4.5-.6 0-1.2.1-1.7.3"/><path d="m2.5 2.5 11 11"/>', s),
    folder: (s = 16) => svg('<path d="M1.8 4.6c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>', s),
    folderLarge: (s = 28) => `<svg width="${s}" height="${s}" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.2c0-1.2.9-2.1 2.1-2.1h5.2l2.4 2.7h9.2c1.2 0 2.1.9 2.1 2.1v9.8c0 1.2-.9 2.1-2.1 2.1H5.6c-1.2 0-2.1-.9-2.1-2.1z"/></svg>`,
    shield: (s = 15) => svg('<path d="M8 1.8 3 3.6v3.9c0 3 2 5.3 5 6.7 3-1.4 5-3.7 5-6.7V3.6z"/><path d="m5.8 8 1.7 1.7L10.4 6.6"/>', s),
    check: (s = 14) => svg('<path d="m3.2 8.4 3 3 6.6-6.8"/>', s),
    warn: (s = 14) => svg('<path d="M8 2.2 14.2 13H1.8z"/><path d="M8 6.5v3.2M8 11.3v.2"/>', s),
    bolt: (s = 14) => svg('<path d="M8.8 1.8 3.8 9h3.7l-.6 5.2 5.3-7.4H8.4z"/>', s),
    reveal: (s = 14) => svg('<path d="M9 3h4v4"/><path d="M13 3 7.5 8.5"/><path d="M11 9.5v2.3c0 .7-.5 1.2-1.2 1.2H4.2c-.7 0-1.2-.5-1.2-1.2V6.2C3 5.5 3.5 5 4.2 5h2.3"/>', s),
    plus: (s = 14) => svg('<path d="M8 3v10M3 8h10"/>', s),
    chevron: (s = 14) => svg('<path d="m6 3.5 4.5 4.5L6 12.5"/>', s),
  };
})();
