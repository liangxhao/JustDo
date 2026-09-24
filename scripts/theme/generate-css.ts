import { writeFileSync } from 'fs';
import { resolve } from 'path';

import { generateAllThemesCSS } from '../../src/renderer/theme/engine/css-generator';
import { allThemes } from '../../src/renderer/theme/themes';

const css = generateAllThemesCSS(allThemes);
const outPath = resolve(__dirname, '../../src/renderer/theme/css/themes.css');
writeFileSync(outPath, css, 'utf-8');
console.log(`✅ Generated ${outPath} (${css.length} bytes)`);
