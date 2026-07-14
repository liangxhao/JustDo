import { classicDark }  from '@/theme/themes/classic-dark';
import { classicLight } from '@/theme/themes/classic-light';
import { cyber } from '@/theme/themes/cyber';
import { dawn } from '@/theme/themes/dawn';
import { daylight } from '@/theme/themes/daylight';
import { emerald } from '@/theme/themes/emerald';
import { midnight } from '@/theme/themes/midnight';
import { mocha } from '@/theme/themes/mocha';
import { nord } from '@/theme/themes/nord';
import { ocean } from '@/theme/themes/ocean';
import { paper } from '@/theme/themes/paper';
import { rose } from '@/theme/themes/rose';
import { sakura } from '@/theme/themes/sakura';
import { sunset } from '@/theme/themes/sunset';
import type { ThemeDefinition } from '@/theme/themes/types';

/** All built-in themes. First entry is the default. */
export const allThemes: ThemeDefinition[] = [
  classicLight,
  classicDark,
  dawn,
  daylight,
  paper,
  sakura,
  midnight,
  ocean,
  emerald,
  rose,
  mocha,
  sunset,
  nord,
  cyber,
];

/** Quick lookup by theme ID */
export const themeMap = new Map(allThemes.map((t) => [t.meta.id, t]));
