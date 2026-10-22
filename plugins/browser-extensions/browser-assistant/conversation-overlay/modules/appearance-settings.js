import { initializeAppearance, THEMES } from './appearance.js';
import { language } from './options-i18n.js';

const translations = {
  zh: {
    title: '背景颜色',
    label: '背景主题',
    hint: '自动保存，并立即应用到设置页和已打开的对话侧栏。',
    dark: '深色',
    light: '浅色',
    warm: '暖纸色',
    blue: '雾蓝',
    system: '跟随系统',
    preview: '对话预览',
    reply: '正文、卡片和输入区会一起调整，保持清晰易读。',
    prompt: '输入消息…',
    saved: '已保存',
    failed: '保存失败，请重试。',
  },
  en: {
    title: 'Background color',
    label: 'Background theme',
    hint: 'Saved automatically and applied to settings and open chat side panels.',
    dark: 'Dark',
    light: 'Light',
    warm: 'Warm paper',
    blue: 'Mist blue',
    system: 'System',
    preview: 'Chat preview',
    reply: 'Text, cards, and the composer adapt together to stay readable.',
    prompt: 'Type a message…',
    saved: 'Saved',
    failed: 'Could not save. Please try again.',
  },
};
const t = translations[language];
const section = document.getElementById('appearance');
const heading = document.createElement('h2');
heading.id = 'appearanceTitle';
heading.textContent = t.title;
const label = document.createElement('label');
label.htmlFor = 'chatTheme';
label.textContent = t.label;
const select = document.createElement('select');
select.id = 'chatTheme';
select.disabled = true;
for (const value of THEMES) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = t[value];
  select.append(option);
}
const hint = document.createElement('p');
hint.className = 'appearance-hint';
hint.textContent = t.hint;
const preview = document.createElement('div');
preview.className = 'appearance-preview';
const title = document.createElement('strong');
title.textContent = t.preview;
const reply = document.createElement('p');
reply.textContent = t.reply;
const composer = document.createElement('div');
composer.className = 'appearance-composer';
composer.textContent = t.prompt;
preview.append(title, reply, composer);
const status = document.createElement('p');
status.setAttribute('role', 'status');
section.append(heading, label, select, hint, preview, status);
let saved = 'light';
const appearance = await initializeAppearance({
  onChange: value => {
    saved = value;
    select.value = value;
  },
});
select.disabled = false;
select.addEventListener('change', async () => {
  select.disabled = true;
  status.textContent = '';
  try {
    await appearance.select(select.value);
    status.textContent = t.saved;
  } catch {
    select.value = saved;
    status.textContent = t.failed;
  } finally {
    select.disabled = false;
  }
});
