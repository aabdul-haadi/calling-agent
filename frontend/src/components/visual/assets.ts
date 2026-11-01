/**
 * The one place that decides which picture stands for which idea. Everything is a 3dicons "Color,
 * Dynamic" render (CC0, see public/visuals/LICENSES.md), so the whole product shares one lighting,
 * perspective and palette. Pages ask for a meaning (`handoffs`), never a file name.
 */
export const VISUAL_ASSETS = {
  // navigation and the main areas of the product
  health: 'battery',
  console: 'computer',
  conversations: 'chat-bubble',
  chat: 'chat-text',
  handoffs: 'headphone',
  knowledge: 'notebook',
  learning: 'bulb',
  quality: 'sheild',
  traces: 'zoom',
  voice: 'mic',
  architecture: 'puzzle',
  models: 'rocket',
  settings: 'setting',
  // measurements and states
  analytics: 'chart',
  tools: 'tool',
  approval: 'flag',
  time: 'clock',
  security: 'lock',
  award: 'medal',
  online: 'wifi',
  // empty states and calm "all clear" moments
  allClear: 'thumb-up',
  newDocument: 'file-plus',
  document: 'file-text',
  target: 'target',
  lab: 'lab',
  folder: 'folder',
  savedFolder: 'fav-folder',
  announce: 'megaphone',
  call: 'phone-ringing',
  trophy: 'trophy',
  key: 'key',
  mail: 'mail',
  calendar: 'calender',
  star: 'star',
  magic: 'magic-trick',
  done: 'tick',
} as const;

export type VisualKey = keyof typeof VISUAL_ASSETS;

const BASE = '/visuals/3d';

/** URL of an asset at one of the two shipped widths. */
export function visualUrl(key: VisualKey, width: 96 | 256 = 96): string {
  return `${BASE}/${VISUAL_ASSETS[key]}-${width}.webp`;
}

export function visualSrcSet(key: VisualKey): string {
  return `${visualUrl(key, 96)} 96w, ${visualUrl(key, 256)} 256w`;
}
