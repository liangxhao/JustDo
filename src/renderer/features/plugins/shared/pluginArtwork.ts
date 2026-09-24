// Walk across the hue wheel in large jumps instead of placing related colours
// together. Sixteen tones keep typical plugin groups varied while preserving
// strong contrast between horizontal and vertical neighbours in the two-column grid.
const PLUGIN_ARTWORK_TONES = [
  'from-red-500/25 via-rose-500/10 to-transparent text-red-600 dark:text-red-300',
  'from-green-500/25 via-emerald-500/10 to-transparent text-green-600 dark:text-green-300',
  'from-blue-500/25 via-indigo-500/10 to-transparent text-blue-600 dark:text-blue-300',
  'from-rose-500/25 via-pink-500/10 to-transparent text-rose-600 dark:text-rose-300',
  'from-lime-500/25 via-green-500/10 to-transparent text-lime-600 dark:text-lime-300',
  'from-sky-500/25 via-blue-500/10 to-transparent text-sky-600 dark:text-sky-300',
  'from-fuchsia-500/25 via-pink-500/10 to-transparent text-fuchsia-600 dark:text-fuchsia-300',
  'from-yellow-500/25 via-amber-500/10 to-transparent text-yellow-600 dark:text-yellow-300',
  'from-cyan-500/25 via-sky-500/10 to-transparent text-cyan-600 dark:text-cyan-300',
  'from-purple-500/25 via-violet-500/10 to-transparent text-purple-600 dark:text-purple-300',
  'from-amber-500/25 via-orange-500/10 to-transparent text-amber-600 dark:text-amber-300',
  'from-teal-500/25 via-cyan-500/10 to-transparent text-teal-600 dark:text-teal-300',
  'from-violet-500/25 via-fuchsia-500/10 to-transparent text-violet-600 dark:text-violet-300',
  'from-orange-500/25 via-red-500/10 to-transparent text-orange-600 dark:text-orange-300',
  'from-emerald-500/25 via-teal-500/10 to-transparent text-emerald-600 dark:text-emerald-300',
  'from-indigo-500/25 via-blue-500/10 to-transparent text-indigo-600 dark:text-indigo-300',
] as const;

export const getPluginArtworkTone = (value: string, visualIndex?: number): string => {
  const hash = [...value].reduce(
    (total, character) => (total * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  const toneIndex = visualIndex === undefined ? hash : hash + visualIndex;
  return PLUGIN_ARTWORK_TONES[toneIndex % PLUGIN_ARTWORK_TONES.length];
};
