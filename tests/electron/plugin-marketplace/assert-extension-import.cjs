'use strict';
/* global window, document, MutationObserver */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const IMPORT = 'extensions:import';
const SET_ENABLED = 'extensions:set-enabled';
const DELETE = 'extensions:delete';
const stageLabels = {
  preparing: '读取插件信息和当前状态',
  extracting: '解压安装包',
  validating: '检查插件格式和安全性',
  preparing_runtime: '准备插件运行环境',
  installing: '安装插件',
  installing_dependencies: '安装插件依赖',
  saving_configuration: '保存插件配置',
  enabling: '启用插件',
  applying_configuration: '应用配置并等待运行环境',
  restarting_gateway: '重启运行环境并重新连接',
  confirming: '确认插件实际状态',
  refreshing_inventory: '刷新插件列表',
  cleaning_up: '清理临时文件',
  rolling_back: '恢复此前配置',
};
const progressSelector = '[role="status"][aria-live="polite"]';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// StructuredMessage renders process bullets as name/PID chips. Compare their
// content while ignoring only layout and those decorative bullet/parentheses.
const comparableMessage = text => text.replace(/[\s•()（）]/g, '');
function failureUiChecks(outcome, progressFinished) {
  return {
    stageVisible: Boolean(outcome.result.failedStage && outcome.dialogText.includes(stageLabels[outcome.result.failedStage] || outcome.result.failedStage)),
    originalMessageVisible: Boolean(outcome.result.error && comparableMessage(outcome.dialogText).includes(comparableMessage(outcome.result.error))),
    progressFinished,
  };
}

// Await bridge calls in the driver, never a Promise returned by waitForFunction.
// Failed mutations get one reconciliation read. Successful receipts allow slow,
// bounded confirmation; native MCP inspection launches a real CLI on every read.
async function until(read, timeout = 300000, message = 'The real UI operation did not settle') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

const readEvidence = page => page.evaluate(() => window.marketplaceProbe.evidence());
const readInventory = page => page.evaluate(() => window.marketplaceProbe.nativeInventory());
async function confirmInventory(page, validate, options, label) {
  const startedAt = Date.now();
  const deadline = startedAt + 45000;
  const confirmation = { label, timeoutMs: 45000, intervalMs: 2000, reads: [], matched: false };
  (options.report.inventoryConfirmations ??= []).push(confirmation);
  let lastError;
  while (Date.now() < deadline) {
    const readStartedAt = Date.now();
    const attempt = { atMs: readStartedAt - startedAt };
    confirmation.reads.push(attempt);
    let timer;
    try {
      const inventory = await Promise.race([
        readInventory(page),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The read-only native inventory deadline expired')), deadline - Date.now());
        }),
      ]);
      attempt.inventory = inventory;
      attempt.readMs = Date.now() - readStartedAt;
      validate(inventory);
      confirmation.matched = true;
      confirmation.elapsedMs = Date.now() - startedAt;
      return inventory;
    } catch (error) {
      lastError = error;
      attempt.readMs = Date.now() - readStartedAt;
      attempt.mismatch = error.message;
    } finally {
      clearTimeout(timer);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(2000, remaining));
  }
  confirmation.elapsedMs = Date.now() - startedAt;
  throw new Error(`${label}: native inventory did not converge within 45 seconds: ${lastError?.message}`);
}
const importButton = page => page.getByTestId('extension-import-pane').getByRole('button', { name: /^(导入扩展|Import Extension|导入中|Importing)$/ });
const reviewModal = page => page.locator('[data-workspace-overlay="true"]').filter({
  has: page.getByText(/^(审查扩展能力|Review extension capabilities)$/, { exact: true }),
});
const extensionCard = (page, item) => page.locator('article').filter({
  has: page.getByRole('heading', { name: item.name, exact: true }),
});
const entriesSince = (evidence, before, channel) => evidence.operationResults
  .slice(before.operationResults.length).filter(entry => entry.channel === channel);

async function screenshot(page, output, name) {
  if (!output) return;
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled', timeout: 10000 });
}

async function closeOutcome(page) {
  const modal = page.getByRole('alertdialog');
  if (await modal.count()) {
    await modal.locator('[data-primary-action]').click();
    await modal.waitFor({ state: 'detached' });
  }
}

function fixturePath(fixturesRoot, item) {
  const input = fs.realpathSync(path.join(fixturesRoot, item.archives[0]));
  const relative = path.relative(fixturesRoot, input);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  return input;
}

async function pickArchives(page, paths) {
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'An existing result must be dismissed explicitly');
  await until(async () => await importButton(page).count() === 1 && await importButton(page).isEnabled(),
    120000, 'The production import control stayed locked');
  await page.evaluate(paths => window.marketplaceProbe.selectInputs(paths), paths);
  await importButton(page).click();
  await page.getByRole('button', { name: /^(选择压缩文件|Select archives)/ }).click();
}

async function waitForOutcome(page) {
  return until(async () => {
    if (await page.getByRole('alertdialog').count()) return 'result';
    if (await reviewModal(page).count()) return 'review';
    return undefined;
  });
}

async function observeProgress(page) {
  await page.evaluate(selector => {
    window.__extensionImportObservedProgress = [];
    const capture = () => {
      for (const element of document.querySelectorAll(selector)) {
        const text = element.textContent?.trim();
        const values = window.__extensionImportObservedProgress;
        if (text && values[values.length - 1] !== text) values.push(text);
      }
    };
    window.__extensionImportProgressObserver?.disconnect();
    window.__extensionImportProgressObserver = new MutationObserver(capture);
    window.__extensionImportProgressObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    capture();
  }, progressSelector);
}

function capabilitySnapshot(inventory, item) {
  return {
    extensions: inventory.extensions.filter(entry => entry.id === item.id),
    skills: inventory.skills.filter(entry => item.skills.some(skill => skill.name === entry.name)),
    mcp: inventory.mcp.filter(entry => entry.providerId === item.id),
    hooks: inventory.hooks.filter(entry => entry.pluginId === item.id),
  };
}

function assertInstalled(inventory, item) {
  const state = capabilitySnapshot(inventory, item);
  assert.equal(state.extensions.length, 1, `Exactly one native extension ${item.id}`);
  assert.equal(state.extensions[0].version, item.version, 'Version must come from native catalog');
  assert.equal(state.extensions[0].enabled, true, 'Fresh local imports must be enabled');
  assert.ok(state.extensions[0].installPath && fs.existsSync(state.extensions[0].installPath), 'The native installation must exist');
  assert.deepEqual(state.skills.map(entry => entry.name).sort(), item.skills.map(entry => entry.name).sort());
  assert.deepEqual(state.mcp.map(entry => entry.name).sort(), [...item.servers].sort());
  assert.deepEqual(state.hooks.map(entry => entry.name).sort(), [...item.hooks].sort());
  assert.ok(state.mcp.every(entry => entry.enabled === true), 'MCP definitions must follow the enabled parent');
  assert.ok(state.skills.every(entry => entry.eligible === true && entry.disabled === false), 'Enabled fixture skills must be eligible');
  assert.ok(state.hooks.every(entry => entry.enabledByConfig === true && entry.loadable === true), 'Enabled fixture hooks must be loadable');
  return state;
}

async function runNegativeBatch(page, options) {
  const { fixturesRoot, catalog, output } = options;
  const items = catalog.items.filter(item => item.expected === 'reject');
  assert.equal(items.length, 16, 'Use all sixteen existing negative archives');
  const inputs = items.map(item => fixturePath(fixturesRoot, item));
  const inventoryBefore = await readInventory(page);
  const before = await readEvidence(page);
  await observeProgress(page);
  await pickArchives(page, inputs);
  assert.equal(await waitForOutcome(page), 'result', 'A malformed package must not ask for capability authorization');
  const modal = page.getByRole('alertdialog');
  await modal.waitFor({ state: 'visible' });
  assert.equal(await modal.count(), 1, 'The batch must use a single aggregate failure dialog');
  await modal.getByText('成功 0 项，失败 16 项。', { exact: true }).waitFor({ state: 'visible' });
  await modal.getByText('详见下方各项', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await modal.getByText('未收到步骤信息', { exact: true }).count(), 0, 'A batch with per-item stages must not claim that stage information is missing');
  const evidence = await readEvidence(page);
  const operations = entriesSince(evidence, before, IMPORT);
  options.report.negativeImportResults = operations;
  assert.equal(operations.length, 16, 'Each original invalid archive must be attempted exactly once');
  const outcomes = [];
  for (const [index, item] of items.entries()) {
    const entry = operations[index];
    assert.equal(path.resolve(entry.request.sourcePath), inputs[index]);
    assert.equal(entry.request.reviewToken, undefined);
    assert.equal(entry.result.success, false, `${item.folder}: ${JSON.stringify(entry.result)}`);
    assert.equal(entry.result.failedStage, item.expectedStage, `${item.folder}: stage from real Main response`);
    assert.notEqual(entry.result.installationCommitted, true, `${item.folder}: rejection must not fabricate a commit`);
    assert.notEqual(entry.result.installSourceInUse, true);
    assert.notEqual(entry.result.operationUnconfirmed, true);
    assert.equal(entry.result.capabilityReview, undefined);
    assert.ok(typeof entry.result.error === 'string' && entry.result.error.length > 0);
    const label = modal.getByText(path.basename(inputs[index]), { exact: true });
    await label.waitFor({ state: 'visible' });
    const itemText = await label.locator('xpath=../..').innerText();
    assert.ok(itemText.includes(stageLabels[entry.result.failedStage]), `${item.folder}: its own card must show its own failed stage`);
    const errorFirstLine = entry.result.error.split(/\r?\n/).find(line => line.trim());
    assert.ok(comparableMessage(itemText).includes(comparableMessage(errorFirstLine)), `${item.folder}: its own native error must remain visible`);
    outcomes.push({ fixture: item.folder, sourcePath: inputs[index], result: entry.result });
  }
  for (const stage of new Set(items.map(item => item.expectedStage))) {
    assert.ok((await modal.innerText()).includes(stageLabels[stage]), `The UI must expose the actual ${stage} stage for batch items`);
  }
  const progress = evidence.operationProgress.slice(before.operationProgress.length);
  assert.ok(progress.length > 0, 'Real import IPC must emit progress');
  const observedProgress = await page.evaluate(() => window.__extensionImportObservedProgress);
  assert.ok(observedProgress.length > 0, 'The production progress card must render during the real batch');
  assert.equal(await page.locator(progressSelector).count(), 0, 'The progress card must finish before the error dialog');
  const dialogText = await modal.innerText();
  await screenshot(page, output, 'extension-import-sixteen-invalid');
  const inventoryAfter = await readInventory(page);
  assert.deepEqual(inventoryAfter, inventoryBefore, 'Rejected original archives must leave the native extension and child inventories unchanged');
  await closeOutcome(page);
  assert.equal(await importButton(page).isEnabled(), true, 'A settled rejection releases the import control');
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'Closing the aggregate failure must not reveal sixteen duplicate dialogs');
  return { outcomes, dialogText, observedProgress, progress, inventoryBefore, inventoryAfter, retryEnabled: true };
}

async function importValid(page, item, options, cancel = false) {
  const input = fixturePath(options.fixturesRoot, item);
  const before = await readEvidence(page);
  await observeProgress(page);
  await pickArchives(page, [input]);
  const firstOutcome = await waitForOutcome(page);
  const review = reviewModal(page);
  const initial = entriesSince(await readEvidence(page), before, IMPORT);
  assert.equal(firstOutcome, 'review', `${item.folder}: initial response: ${JSON.stringify(initial)}`);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].result.success, false);
  assert.ok(initial[0].result.capabilityReview?.reviewToken, 'Native preflight must supply a concrete review token');
  assert.equal(initial[0].request.reviewToken, undefined);
  assert.notEqual(initial[0].result.installationCommitted, true);
  await screenshot(page, options.output, `extension-import-${item.folder.replace(/[^\w-]/g, '_')}-${cancel ? 'cancel-review' : 'review'}`);
  const reviewText = await review.innerText();
  if (cancel) {
    await review.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
    await review.waitFor({ state: 'detached' });
    const inventory = await readInventory(page);
    const state = capabilitySnapshot(inventory, item);
    assert.deepEqual(state, { extensions: [], skills: [], mcp: [], hooks: [] }, 'Cancelling authorization must not install the extension or any child');
    assert.equal(entriesSince(await readEvidence(page), before, IMPORT).length, 1, 'Cancellation must not submit a second import');
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'Review cancellation is not a failure');
    return { fixture: item.folder, cancelled: true, reviewText, nativeState: state };
  }
  await review.getByRole('button', { name: /^(接受并继续|Accept and continue)$/ }).click();
  assert.equal(await waitForOutcome(page), 'result');
  const modal = page.getByRole('alertdialog');
  await modal.waitFor({ state: 'visible' });
  const after = await readEvidence(page);
  const operations = entriesSince(after, before, IMPORT);
  assert.equal(operations.length, 2, 'A reviewed import has exactly one preflight and one confirmed attempt');
  const final = operations[1];
  assert.equal(final.request.sourcePath, initial[0].request.sourcePath);
  assert.equal(final.request.requestId, initial[0].request.requestId);
  assert.equal(final.request.reviewToken, initial[0].result.capabilityReview.reviewToken, 'Confirmation must use the exact native review token');
  const result = final.result;
  const dialogText = await modal.innerText();
  await screenshot(page, options.output, `extension-import-${item.folder.replace(/[^\w-]/g, '_')}-result`);
  // A real native failure, including a busy Windows rename, is surfaced as-is;
  // this probe never repeats a mutation to turn an uncertain receipt into success.
  const outcome = { fixture: item.folder, result, reviewText, dialogText, exactReviewToken: true,
    observedProgress: await page.evaluate(() => window.__extensionImportObservedProgress),
    progress: after.operationProgress.slice(before.operationProgress.length) };
  options.outcomes.push(outcome);
  // The original fixture contract allows native skill discovery to settle after
  // the install receipt. Each attempt is a real read, retained without smoothing
  // the bridge response; a failed mutation is never retried or treated as ready.
  const inventory = result.success
    ? await confirmInventory(page, inventory => assertInstalled(inventory, item), options, `import ${item.folder}`)
    : await readInventory(page);
  outcome.inventory = inventory;
  if (!result.success) {
    outcome.failureUi = failureUiChecks(outcome, await page.locator(progressSelector).count() === 0);
    outcome.failureUiVerified = Object.values(outcome.failureUi).every(value => value === true);
    outcome.nativeState = capabilitySnapshot(inventory, item);
  }
  assert.equal(result.success, true, `${item.folder}: actual native import failed: ${JSON.stringify(result)}`);
  assert.ok(dialogText.includes(`扩展 ${item.id} 导入成功`) || dialogText.includes(`Extension ${item.id} imported successfully`),
    'A successful native receipt must also reach the production import success dialog');
  assert.equal(await modal.getByRole('button', { name: /^(复制错误详情|Copy error details)$/ }).count(), 0,
    'A refresh failure dialog must not be counted as a successful complete import');
  outcome.nativeState = assertInstalled(inventory, item);
  assert.ok(outcome.observedProgress.length > 0, 'Real import progress must be visible');
  await closeOutcome(page);
  await extensionCard(page, item).waitFor({ state: 'visible' });
  assert.equal(await extensionCard(page, item).count(), 1);
  return outcome;
}

async function toggleParent(page, item, enabled, options) {
  const before = await readEvidence(page);
  const card = extensionCard(page, item);
  const toggle = card.getByRole('switch');
  assert.equal(await toggle.isEnabled(), true);
  assert.equal(await toggle.getAttribute('aria-checked'), String(!enabled));
  await toggle.click();
  let entries;
  let acceptedReview = false;
  await until(async () => {
    entries = entriesSince(await readEvidence(page), before, SET_ENABLED);
    if (entries.length && entries[entries.length - 1].result.capabilityReview) {
      if (acceptedReview) return false;
      const review = reviewModal(page);
      await review.waitFor({ state: 'visible' });
      await review.getByRole('button', { name: /^(接受并继续|Accept and continue)$/ }).click();
      acceptedReview = true;
      return false;
    }
    return entries.length > 0;
  });
  const final = entries[entries.length - 1];
  assert.equal(final.request.extensionId, item.id);
  assert.equal(final.request.enabled, enabled);
  if (entries.length > 1) {
    assert.equal(final.request.reviewToken, entries[0].result.capabilityReview.reviewToken);
  }
  const inventory = final.result.success
    ? await confirmInventory(page, inventory => {
      const state = capabilitySnapshot(inventory, item);
      assert.equal(state.extensions.length, 1);
      assert.equal(state.extensions[0].enabled, enabled);
      if (enabled) assertInstalled(inventory, item);
      else {
        assert.ok(state.mcp.every(entry => entry.enabled === false));
        assert.ok(state.skills.every(entry => entry.disabled === true || entry.eligible === false));
        assert.ok(state.hooks.every(entry => entry.disabled === true || entry.eligible === false || entry.enabled === false));
      }
    }, options, `${enabled ? 'enable' : 'disable'} ${item.folder}`)
    : await readInventory(page);
  const state = capabilitySnapshot(inventory, item);
  const outcome = { fixture: item.folder, enabled, result: final.result, nativeState: state };
  options.outcomes.push(outcome);
  assert.equal(final.result.success, true, `Parent toggle: ${JSON.stringify(final.result)}`);
  assert.equal(state.extensions.length, 1);
  assert.equal(state.extensions[0].enabled, enabled);
  if (enabled) assertInstalled(inventory, item);
  else {
    assert.ok(state.mcp.every(entry => entry.enabled === false), 'Parent disable must disable its declared MCP definitions');
    assert.ok(state.skills.every(entry => entry.disabled === true || entry.eligible === false), 'Parent disable must not leave an eligible child skill');
    assert.ok(state.hooks.every(entry => entry.disabled === true || entry.eligible === false || entry.enabled === false), 'Parent disable must not leave an enabled hook');
  }
  await until(async () => await toggle.getAttribute('aria-checked') === String(enabled) && await toggle.isEnabled());
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'Successful toggles must not show a failure dialog');
  await screenshot(page, options.output, `extension-import-${item.id}-${enabled ? 'enabled' : 'disabled'}`);
  return outcome;
}

async function uninstallParent(page, item, options) {
  const before = await readEvidence(page);
  const inventoryBefore = await readInventory(page);
  const installed = inventoryBefore.extensions.find(entry => entry.id === item.id);
  assert.ok(installed);
  const card = extensionCard(page, item);
  await card.locator('button[aria-label]').first().click();
  await page.getByRole('button', { name: /^(删除扩展|Delete extension)$/, exact: true }).click();
  const confirmation = page.locator('[data-workspace-overlay="true"]').filter({
    has: page.getByText(/^(确定删除扩展|Delete extension [“"])/),
  });
  await confirmation.waitFor({ state: 'visible' });
  // Use the actual confirmation button; its busy text changes after admission.
  const remove = page.getByRole('button', { name: /^(删除|Delete)$/, exact: true });
  await remove.click();
  await until(async () => entriesSince(await readEvidence(page), before, DELETE).length > 0);
  const entries = entriesSince(await readEvidence(page), before, DELETE);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].request.extensionId, item.id);
  const inventory = entries[0].result.success
    ? await confirmInventory(page, inventory => assert.deepEqual(capabilitySnapshot(inventory, item),
      { extensions: [], skills: [], mcp: [], hooks: [] }), options, `uninstall ${item.folder}`)
    : await readInventory(page);
  const outcome = { fixture: item.folder, result: entries[0].result, nativeState: capabilitySnapshot(inventory, item) };
  options.outcomes.push(outcome);
  assert.equal(entries[0].result.success, true, `Uninstall: ${JSON.stringify(entries[0].result)}`);
  assert.deepEqual(outcome.nativeState, { extensions: [], skills: [], mcp: [], hooks: [] });
  assert.equal(fs.existsSync(installed.installPath), false, 'Successful native uninstall removes its formal directory');
  await confirmation.waitFor({ state: 'detached' });
  const modal = page.getByRole('alertdialog');
  await modal.waitFor({ state: 'visible' });
  outcome.dialogText = await modal.innerText();
  assert.ok(outcome.dialogText.includes(`扩展 ${item.name} 已删除`) || outcome.dialogText.includes(`Extension ${item.name} deleted`),
    'A successful native removal must also reach the production removal success dialog');
  assert.equal(await modal.getByRole('button', { name: /^(复制错误详情|Copy error details)$/ }).count(), 0,
    'A refresh failure dialog must not be counted as a successful complete removal');
  await closeOutcome(page);
  await card.waitFor({ state: 'detached' });
  return outcome;
}

exports.run = async function run(page, options) {
  const { suite = 'all', catalog, report } = options;
  const outcomes = [];
  // Attach incrementally so a genuine native failure still leaves useful results.
  report.extensionImportOutcomes = outcomes;
  options = { ...options, outcomes };
  if (suite === 'all' || suite === 'negative') {
    console.log('[Extension import UI] Importing the sixteen original invalid archives as one batch');
    const negative = await runNegativeBatch(page, options);
    outcomes.push({ negativeBatch: negative });
    report.checks.push('16 original invalid archives: real IPC rejection, exact failedStage, one structured dialog, live progress and unchanged native inventory');
  }
  if (suite !== 'negative') {
    const item = folder => {
      const found = catalog.items.find(entry => entry.folder === folder);
      assert.ok(found, `Existing catalog fixture ${folder}`);
      return found;
    };
    if (suite === 'uninstall') {
      const all = item('07-all');
      report.omittedBySuite = ['09 中文 空格', 'v1 → v2', '16 negative inputs', 'review cancellation', 'parent toggle'];
      console.log('[Extension import UI] Preparing one parent for the previously unexecuted uninstall path');
      await importValid(page, all, options);
      report.checks.push('07-all native setup for an isolated uninstall workflow');
      await uninstallParent(page, all, options);
      assert.deepEqual(await readInventory(page), { extensions: [], skills: [], mcp: [], hooks: [] });
      report.checks.push('Production uninstall removes the parent, formal files and every native child capability');
      await screenshot(page, options.output, 'extension-import-uninstall-finished');
      return outcomes;
    }
    const installedItems = [];
    if (suite !== 'update') {
      const all = item('07-all');
      console.log('[Extension import UI] Reviewing, cancelling and confirming 07-all');
      outcomes.push(await importValid(page, all, options, true));
      report.checks.push('07-all native capability review cancellation leaves no installation');
      await importValid(page, all, options);
      installedItems.push(all);
      report.checks.push('07-all exact native reviewToken confirmation, enabled parent and three native child inventories');
      await toggleParent(page, all, false, options);
      await toggleParent(page, all, true, options);
      report.checks.push('Parent disabled/enabled through the production UI and authoritative child discovery');
      console.log('[Extension import UI] Importing the original Chinese and space path package');
      const unicode = item('09 中文 空格');
      await importValid(page, unicode, options);
      installedItems.push(unicode);
      report.checks.push('Original Unicode archive and native child paths remain usable');
    } else report.omittedBySuite = ['07-all', '09 中文 空格', '16 negative inputs'];
    const v1 = item('10-update-v1');
    const v2 = item('11-update-v2');
    console.log('[Extension import UI] Importing v1 then replacing it with the original v2 package');
    await importValid(page, v1, options);
    report.checks.push('Original v1 imported through its exact native capability review and exposes one Skill/MCP/Hook');
    await importValid(page, v2, options);
    installedItems.push(v2);
    assert.equal(await extensionCard(page, v2).count(), 1, 'Same-ID replacement must leave only one card');
    report.checks.push('Same-ID original v1 → v2: native version 1.1.0 and two Skill/MCP/Hook entries each');
    console.log('[Extension import UI] Uninstalling the imported parents');
    for (const installed of installedItems.reverse()) await uninstallParent(page, installed, options);
    assert.deepEqual(await readInventory(page), { extensions: [], skills: [], mcp: [], hooks: [] });
    report.checks.push('Production uninstall controls remove parents, formal files and every native child capability');
  }
  await screenshot(page, options.output, 'extension-import-finished');
  return outcomes;
};

exports.runNegativeBatch = runNegativeBatch;
exports.failureUiChecks = failureUiChecks;
