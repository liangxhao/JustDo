import { sidePanelText as t } from './sidepanel-i18n.js';

const COMMAND = 'item/commandExecution/requestApproval';
const USER_INPUT = 'item/tool/requestUserInput';
const MAX_REQUESTS = 16;
const MAX_REQUEST_CHARACTERS = 128 * 1024;
const fallback = method => method === COMMAND ? { decision: 'decline' } : { answers: {} };
const text = (value, limit) => typeof value === 'string' && value.length <= limit;

function validRequest(request) {
  const params = request?.params;
  if (!params || !text(params.threadId, 256) || !params.threadId ||
      !text(params.turnId, 256) || !params.turnId || !text(params.itemId, 256) || !params.itemId)
    return false;
  if (request.method === COMMAND) {
    return (params.kind == null || params.kind === 'command') &&
      text(params.command, 65536) && params.command.trim() &&
      (params.cwd == null || text(params.cwd, 8192)) &&
      (params.reason == null || text(params.reason, 16000)) &&
      (params.availableDecisions == null || Array.isArray(params.availableDecisions));
  }
  if (request.method !== USER_INPUT || !Array.isArray(params.questions) ||
      params.questions.length < 1 || params.questions.length > 16) return false;
  const ids = new Set();
  return params.questions.every(question => {
    if (!question || !text(question.id, 128) || !question.id || ids.has(question.id) ||
        !text(question.header, 256) || !text(question.question, 16000) || !question.question.trim() ||
        (question.isOther !== undefined && typeof question.isOther !== 'boolean') ||
        (question.isSecret !== undefined && typeof question.isSecret !== 'boolean')) return false;
    ids.add(question.id);
    if (question.options == null) return true;
    if (!Array.isArray(question.options) || question.options.length > 16) return false;
    const labels = new Set();
    return question.options.every(option => {
      if (!option || !text(option.label, 2048) || !option.label.trim() || labels.has(option.label) ||
          !text(option.description, 4096)) return false;
      labels.add(option.label);
      return true;
    });
  });
}

/** Transient forms only. A response is useful solely while its transport signal and exact owner remain current. */
export function createApprovalPanel(root, options = {}) {
  const document = root.ownerDocument;
  const queue = [];
  let nextFormId = 0;
  let disposed = false;
  const isCurrent = request => !disposed && options.isCurrent?.(request) === true;
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };

  function clearForm() {
    // Clear detached secret inputs as well as removing them from the document.
    for (const input of root.querySelectorAll('input, textarea')) input.value = '';
    root.replaceChildren();
  }

  function finish(entry, result = fallback(entry.request.method)) {
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    entry.signal?.removeEventListener('abort', entry.withdraw);
    entry.resolve(result);
    if (index === 0) render();
    else updateCount();
  }

  function updateCount() {
    const count = root.querySelector('.approval-count');
    if (count) count.textContent = queue.length > 1 ? t('approvalQueue', { count: queue.length }) : '';
  }

  function decide(entry, result) {
    finish(entry, !entry.signal?.aborted && isCurrent(entry.request) ? result : fallback(entry.request.method));
  }

  function renderCommand(entry, body) {
    const params = entry.request.params;
    const details = element('dl', 'approval-context');
    for (const [label, value] of [['approvalCommand', params.command], ['approvalCwd', params.cwd],
      ['approvalReason', params.reason]]) {
      if (!value) continue;
      details.append(element('dt', '', t(label)), element('dd', '', value));
    }
    body.append(details);
    const actions = element('div', 'approval-actions');
    const available = params.availableDecisions ?? ['accept', 'decline', 'cancel'];
    for (const [decision, label] of [['accept', 'approvalAllow'], ['acceptForSession', 'approvalAllowSession'],
      ['decline', 'approvalDeny'], ['cancel', 'approvalCancel']]) {
      if (decision !== 'decline' && !available.includes(decision)) continue;
      const button = element('button', decision === 'accept' ? 'approval-primary' : '', t(label));
      button.type = 'button';
      button.dataset.decision = decision;
      button.addEventListener('click', () => decide(entry, { decision }));
      actions.append(button);
    }
    body.append(actions);
  }

  function renderQuestions(entry, body) {
    const form = element('form', 'approval-form');
    form.autocomplete = 'off';
    const readers = [];
    const submit = element('button', 'approval-primary', t('approvalSubmit'));
    submit.type = 'submit';
    submit.disabled = true;
    const update = () => { submit.disabled = !readers.every(read => read() !== null); };
    for (const question of entry.request.params.questions) {
      const field = element('fieldset', 'approval-question');
      field.append(element('legend', '', question.header || t('approvalQuestion')),
        element('p', 'approval-question-text', question.question));
      const formId = `approval-answer-${++nextFormId}`;
      let selected = null;
      const choices = question.options ?? [];
      const free = choices.length === 0 || question.isOther === true;
      let input;
      choices.forEach((option, index) => {
        const label = element('label', 'approval-choice');
        const radio = element('input');
        radio.type = 'radio';
        radio.name = formId;
        radio.value = String(index);
        radio.addEventListener('change', () => {
          selected = index;
          if (input) input.disabled = true;
          update();
        });
        const copy = element('span', 'approval-choice-copy');
        copy.append(element('strong', '', option.label));
        if (option.description) copy.append(element('span', '', option.description));
        label.append(radio, copy);
        field.append(label);
      });
      if (free) {
        const label = element('label', 'approval-free');
        if (choices.length > 0) {
          const radio = element('input');
          radio.type = 'radio';
          radio.name = formId;
          radio.value = 'other';
          radio.addEventListener('change', () => {
            selected = 'other';
            input.disabled = false;
            input.focus();
            update();
          });
          label.append(radio, element('span', '', t('approvalOther')));
        } else label.append(element('span', '', t(question.isSecret ? 'approvalSecret' : 'approvalAnswer')));
        input = element('input', 'approval-text');
        input.type = question.isSecret ? 'password' : 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.maxLength = 8192;
        input.disabled = choices.length > 0;
        input.setAttribute('aria-label', question.header || question.question);
        input.addEventListener('input', update);
        if (question.isSecret) input.dataset.secret = 'true';
        field.append(label, input);
      }
      readers.push(() => {
        if (typeof selected === 'number') return choices[selected].label;
        if (free && (choices.length === 0 || selected === 'other') && input.value.trim())
          return input.value;
        return null;
      });
      form.append(field);
    }
    const actions = element('div', 'approval-actions');
    const cancel = element('button', '', t('approvalSkip'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => decide(entry, { answers: {} }));
    actions.append(submit, cancel);
    form.append(actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const values = readers.map(read => read());
      if (values.some(value => value === null)) return;
      const answers = Object.create(null);
      entry.request.params.questions.forEach((question, index) => {
        answers[question.id] = { answers: [values[index]] };
      });
      decide(entry, { answers });
    });
    body.append(form);
  }

  function render() {
    clearForm();
    while (queue.length && (queue[0].signal?.aborted || !isCurrent(queue[0].request))) {
      const entry = queue.shift();
      entry.signal?.removeEventListener('abort', entry.withdraw);
      entry.resolve(fallback(entry.request.method));
    }
    const entry = queue[0];
    root.classList.toggle('hidden', !entry);
    if (!entry) return;
    const heading = element('div', 'approval-heading');
    heading.append(element('h2', '', t(entry.request.method === COMMAND ? 'approvalTitle' : 'approvalInputTitle')),
      element('span', 'approval-count'));
    root.append(heading, element('p', 'approval-hint', t('approvalScope')));
    const body = element('div', 'approval-body');
    if (entry.request.method === COMMAND) renderCommand(entry, body);
    else renderQuestions(entry, body);
    root.append(body);
    updateCount();
  }

  return {
    request(request, { signal } = {}) {
      if (disposed || signal?.aborted || !validRequest(request) || !isCurrent(request) ||
          queue.length >= MAX_REQUESTS || JSON.stringify(request.params).length > MAX_REQUEST_CHARACTERS)
        return Promise.resolve(fallback(request?.method));
      return new Promise(resolve => {
        const entry = { request, signal, resolve, withdraw: null };
        entry.withdraw = () => finish(entry);
        queue.push(entry);
        signal?.addEventListener('abort', entry.withdraw, { once: true });
        if (queue.length === 1) render();
        else updateCount();
      });
    },
    cancelAll() {
      for (const entry of [...queue]) finish(entry);
    },
    cancelTurn(threadId, turnId) {
      for (const entry of [...queue])
        if (entry.request.params.threadId === threadId && entry.request.params.turnId === turnId) finish(entry);
    },
    dispose() {
      disposed = true;
      for (const entry of [...queue]) finish(entry);
      clearForm();
    },
  };
}
