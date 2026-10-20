import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

test.each([
  'components/CoworkView.tsx',
  'components/chat/CoworkHomeWorkspace.tsx',
])('%s mounts each retained App only once in the stable workspace container', relativePath => {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(new URL(`../../src/renderer/features/cowork/${relativePath}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const workspaces: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'CoworkDisplayPanel')
      workspaces.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(workspaces).toHaveLength(1);
  for (const workspace of workspaces) {
    const calls: ts.CallExpression[] = [];
    const collect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'mcpAppTabs.panels')
        calls.push(node);
      ts.forEachChild(node, collect);
    };
    collect(workspace);
    // Duplicate calls create independent live iframe owners for the same App entry.
    expect(calls).toHaveLength(1);
    const wrapper = workspace.children.find(ts.isJsxElement);
    expect(wrapper?.openingElement.attributes.properties.some(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'key' &&
      attribute.initializer && ts.isStringLiteral(attribute.initializer) &&
      attribute.initializer.text === 'mcp-app-panels',
    )).toBe(true);
    expect(wrapper && calls[0].pos >= wrapper.pos && calls[0].end <= wrapper.end).toBe(true);
  }
});
