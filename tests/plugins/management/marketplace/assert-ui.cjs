/* global window */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Poll from the driver process. A hidden Electron window may defer animation
// frames even though React, IPC and its native installation are already running.
const waitForDisabledState = async (button, disabled, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  let actual;
  do {
    actual = await button.isDisabled();
    if (actual === disabled) return actual;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(actual, disabled, `Expected the real control disabled state to become ${disabled}`);
  return actual;
};

/** Exercise rendered controls against the isolated Electron preload and real IPC handlers. */
exports.run = async function run(page, options = {}) {
  const {
    output,
    kind = 'skill',
    pluginId = 'catalog-download-failure',
    pluginName = 'Fixture download failure',
    delayMs = 1500,
  } = options;
  const pageErrors = [];
  const onPageError = error => pageErrors.push(error.message);
  page.on('pageerror', onPageError);
  try {
    await page.waitForFunction(
      () => typeof window.marketplaceProbe?.evidence === 'function',
      undefined,
      { polling: 50 },
    );
    const isolated = await page.evaluate(() => ({
      invokeAvailable: typeof window.electron?.marketplace?.install === 'function',
      rendererRequire: typeof require,
      rendererProcess: typeof process,
    }));
    assert.equal(isolated.invokeAvailable, true);
    assert.equal(isolated.rendererRequire, 'undefined');
    assert.equal(isolated.rendererProcess, 'undefined');

    const before = await page.evaluate(() => window.marketplaceProbe.evidence());
    await page.evaluate(scenario => window.marketplaceProbe.setScenario(scenario), {
      pluginId,
      failure: 'download',
      delayMs,
    });
    await page.getByTestId(`category-${kind}`).click();
    const card = page.locator('article').filter({
      has: page.getByText(pluginName, { exact: true }),
    });
    await card.waitFor({ state: 'visible' });
    const install = card.locator('button[aria-label]').last();
    await waitForDisabledState(install, false);
    assert.match(await install.getAttribute('aria-label'), /^(安装|Install)$/);
    assert.equal(await install.isEnabled(), true);
    // Two genuine DOM clicks in the same turn also exercise the synchronous owner lock.
    await install.evaluate(button => {
      button.click();
      button.click();
    });
    const disabledDuringInstall = await waitForDisabledState(install, true);
    assert.equal(disabledDuringInstall, true);

    const progress = page
      .locator('[role="status"][aria-live="polite"]')
      .filter({ hasText: pluginName });
    await progress.waitFor({ state: 'visible' });
    await progress
      .getByText(/正在下载安装包到临时目录|Downloading the package to a temporary folder/)
      .waitFor({ state: 'visible' });
    const progressText = await progress.innerText();
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({
        path: path.join(output, 'marketplace-real-download-progress.png'),
        timeout: 10000,
      });
    }
    await page.getByTestId('category-extension').click();
    await page.getByTestId('catalog-extension').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId(`catalog-${kind}`).count(), 0);
    await progress.waitFor({ state: 'visible' });

    const modal = page.getByRole('alertdialog');
    await modal.waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await modal.count(), 1);
    assert.equal(await modal.getByText(pluginName, { exact: true }).count(), 1);
    await modal.getByText(/^(下载安装包|Download the package)$/).waitFor({ state: 'visible' });
    const failureText = await modal.innerText();
    assert.equal(await page.locator('[role="status"][aria-live="polite"]').count(), 0);
    if (output)
      await page.screenshot({
        path: path.join(output, 'marketplace-real-download-failure.png'),
        timeout: 10000,
      });

    const after = await page.evaluate(() => window.marketplaceProbe.evidence());
    assert.ok(after.installRequests, 'Main evidence must include installRequests per catalog id');
    assert.equal(
      (after.installRequests[pluginId] || 0) - (before.installRequests?.[pluginId] || 0),
      1,
      'Repeated clicks must issue exactly one marketplace install IPC request',
    );

    await modal.locator('[data-primary-action]').click();
    await modal.waitFor({ state: 'detached' });
    await page.getByTestId(`category-${kind}`).click();
    await card.waitFor({ state: 'visible' });
    assert.equal(
      await install.isEnabled(),
      true,
      'A confirmed download failure releases the install lock',
    );
    assert.equal(
      await page.getByRole('alertdialog').count(),
      0,
      'Returning to the original category must not replay the same error',
    );
    assert.deepEqual(pageErrors, []);
    return {
      isolated,
      pluginId,
      progressText,
      failureText,
      installRequestDelta: 1,
      disabledDuringInstall,
      categoryWasUnmounted: true,
      failureSurvivedCategoryChange: true,
      retryEnabled: true,
      pageErrors,
      before,
      after,
    };
  } finally {
    page.off('pageerror', onPageError);
  }
};

const catalogCard = (page, name) =>
  page.locator('article').filter({
    has: page.getByText(name, { exact: true }),
  });

const latestInstallResult = (evidence, pluginId) => {
  const entries = evidence.results.filter(entry => entry.pluginId === pluginId);
  assert.ok(entries.length, `The real Main handler must have settled ${pluginId}`);
  return entries[entries.length - 1].result;
};

/** Fetching and archive failures must leave neither installed skills nor staging files. */
exports.runPackageFailures = async function runPackageFailures(page, { output } = {}) {
  const outcomes = [];
  for (const scenario of [
    {
      pluginId: 'catalog-metadata-failure',
      name: 'Fixture metadata failure',
      runtimeId: 'fixture-market-metadata-failure',
      failure: 'metadata',
      failedStage: 'fetching_metadata',
      stage: /^(获取插件信息|Fetch plugin information)$/,
    },
    {
      pluginId: 'catalog-invalid-archive',
      name: 'Fixture invalid archive',
      runtimeId: 'fixture-market-invalid-archive',
      failure: 'invalid',
      failedStage: 'extracting',
      stage: /^(解压安装包|Extract the package)$/,
    },
  ]) {
    const before = await page.evaluate(() => window.marketplaceProbe.evidence());
    await page.evaluate(scenario => window.marketplaceProbe.setScenario(scenario), {
      pluginId: scenario.pluginId,
      failure: scenario.failure,
      delayMs: 300,
    });
    await page.getByTestId('category-skill').click();
    const card = catalogCard(page, scenario.name);
    await card.waitFor({ state: 'visible' });
    const install = card.locator('button[aria-label]').last();
    await waitForDisabledState(install, false);
    assert.match(await install.getAttribute('aria-label'), /^(安装|Install)$/);
    assert.equal(await install.isEnabled(), true);
    await install.click();

    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ state: 'visible', timeout: 30000 });
    await dialog.getByText(scenario.name, { exact: true }).waitFor({ state: 'visible' });
    await dialog.getByText(scenario.stage).waitFor({ state: 'visible' });
    const evidence = await page.evaluate(() => window.marketplaceProbe.evidence());
    const result = latestInstallResult(evidence, scenario.pluginId);
    assert.equal(result.success, false);
    assert.equal(result.failedStage, scenario.failedStage);
    assert.notEqual(
      result.installationCommitted,
      true,
      'A preparation failure must not invent an installation receipt',
    );
    assert.notEqual(result.installSourceInUse, true);
    assert.notEqual(result.operationUnconfirmed, true);
    assert.equal(
      (evidence.installRequests[scenario.pluginId] || 0) -
        (before.installRequests?.[scenario.pluginId] || 0),
      1,
    );
    const inventory = await page.evaluate(() => window.marketplaceProbe.inventory('skill'));
    assert.equal(
      inventory.installed.some(item => item.id === scenario.runtimeId),
      false,
    );
    assert.ok(
      path.isAbsolute(evidence.native.directory),
      'The native fixture must report its isolated absolute directory',
    );
    const formalDirectory = path.join(
      evidence.native.directory,
      'state',
      'skills',
      scenario.runtimeId,
    );
    assert.equal(
      fs.existsSync(formalDirectory),
      false,
      'A rejected package must not leave a formal installed directory',
    );
    const preparation = evidence.preparations.filter(item => item.pluginId === scenario.pluginId);
    assert.ok(preparation.length > 0);
    assert.equal(preparation[preparation.length - 1].cleaned, true);
    assert.deepEqual(
      evidence.remainingDownloads,
      [],
      'Every rejected preparation must clean its own downloaded temporary files',
    );
    const dialogText = await dialog.innerText();
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({
        path: path.join(output, `marketplace-${scenario.failure}-failure.png`),
        timeout: 10000,
      });
    }
    await dialog.locator('[data-primary-action]').click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(
      await install.isEnabled(),
      true,
      'A settled pre-install failure must allow an explicit retry',
    );
    outcomes.push({
      pluginId: scenario.pluginId,
      result,
      formalDirectoryAbsent: true,
      inventoryAbsent: true,
      cleaned: true,
      remainingDownloads: evidence.remainingDownloads,
      retryEnabled: true,
      dialogText,
    });
  }
  await page.evaluate(() => window.marketplaceProbe.setScenario({}));
  return outcomes;
};

/** Observe native required-configuration validation without injecting an activation failure. */
exports.runRequiredConfiguration = async function runRequiredConfiguration(page, { output } = {}) {
  const pluginId = 'catalog-requires-config';
  const runtimeId = 'fixture-market-requires-config';
  const name = 'Fixture required configuration';
  await page.evaluate(() => window.marketplaceProbe.setScenario({}));
  await page.getByTestId('category-extension').click();
  const card = catalogCard(page, name);
  await card.waitFor({ state: 'visible' });
  const install = card.locator('button[aria-label]').last();
  await waitForDisabledState(install, false);
  assert.match(await install.getAttribute('aria-label'), /^(安装|Install)$/);
  assert.equal(await install.isEnabled(), true);
  await install.click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor({ state: 'visible', timeout: 180000 });
  const evidence = await page.evaluate(() => window.marketplaceProbe.evidence());
  const result = latestInstallResult(evidence, pluginId);
  assert.equal(
    result.success,
    false,
    'Missing required configuration must not be reported as a ready enabled installation',
  );
  assert.equal(result.installationCommitted, true, 'This fixture must exercise the real post-install activation failure');
  assert.equal(result.failedStage, 'enabling');
  await dialog.getByText('插件已安装，但未能完成启用。请检查插件配置和当前状态。', { exact: true })
    .waitFor({ state: 'visible' });
  const inventory = await page.evaluate(() => window.marketplaceProbe.inventory('extension'));
  const installed = inventory.installed.find(item => item.id === runtimeId);
  const unconfirmed = result.installSourceInUse === true || result.operationUnconfirmed === true;
  if (result.installationCommitted) {
    assert.ok(installed, 'An explicit committed failure must retain its real installed identity');
    assert.equal(
      installed.enabled,
      false,
      'Rejected native activation must keep the saved disabled state',
    );
    assert.ok(installed.installPath && fs.existsSync(installed.installPath));
  } else if (!unconfirmed) {
    assert.equal(
      installed,
      undefined,
      'A confirmed pre-install rejection must not leave an installed inventory item',
    );
  }
  const dialogText = await dialog.innerText();
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: path.join(output, 'marketplace-required-configuration-failure.png'),
      timeout: 10000,
    });
  }
  await dialog.locator('[data-primary-action]').click();
  await dialog.waitFor({ state: 'detached' });
  const outcome = {
    pluginId,
    result,
    installed,
    unconfirmed,
    dialogText,
    nativeValidation: true,
    installedBeforeFailure: result.installationCommitted === true,
    remainingDownloads: evidence.remainingDownloads,
  };
  if (result.installationCommitted || unconfirmed) {
    const action = card.locator('button[aria-label]').last();
    assert.equal(
      await action.isDisabled(),
      true,
      'Committed or uncertain native results must not offer the same install again',
    );
  } else assert.equal(await install.isEnabled(), true);
  return outcome;
};
