import { writeFileSync } from 'fs';
import { resolve } from 'path';

import { generateAllThemesCSS } from '@/theme/engine/css-generator';
import { allThemes } from '@/theme/themes';

const css = generateAllThemesCSS(allThemes);
const outPath = resolve(__dirname, '..', 'css', 'themes.css');
writeFileSync(outPath, css, 'utf-8');
console.log(`✅ Generated ${outPath} (${css.length} bytes)`);
