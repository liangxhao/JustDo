/* Appended to the pinned editor bundle before App.main. The native sandbox blocks
 * direct downloads; every visible export uses the standard MCP host Save dialog. */
(() => {
  const init = Menus.prototype.init;
  Menus.prototype.init = function () {
    init.apply(this, arguments);
    this.put(
      'exportAs',
      new Menu((menu, parentItem) => {
        for (const [label, format] of [
          ['PNG', 'png'],
          ['SVG', 'svg'],
          ['draw.io', 'drawio'],
        ]) {
          menu.addItem(
            label,
            null,
            () => {
              this.editorUi.editor.graph.stopEditing(false);
              parent.postMessage(JSON.stringify({ event: 'diagram-export', format }), '*');
            },
            parentItem,
          );
        }
      }),
    );
    this.editorUi.actions.get('print')?.setEnabled(false);
    const ui = this.editorUi;
    let generation = 0;
    ui.editor.graph.model.addListener(mxEvent.CHANGE, () => generation++);
    const snapshot = () => {
      const node = ui.getXmlFileData(true, false, true);
      for (const model of node.getElementsByTagName('mxGraphModel')) {
        model.removeAttribute('dx');
        model.removeAttribute('dy');
      }
      return { xml: mxUtils.getXml(node), generation };
    };
    window.addEventListener('message', event => {
      if (event.source !== parent || typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data);
        if (data.action === 'diagram-theme' && typeof data.dark === 'boolean')
          ui.setDarkMode(data.dark);
        if (data.action === 'diagram-snapshot' && typeof data.requestId === 'string') {
          ui.editor.graph.stopEditing(false);
          parent.postMessage(
            JSON.stringify({ event: 'diagram-snapshot', requestId: data.requestId, ...snapshot() }),
            '*',
          );
        }
        if (data.action === 'diagram-apply' && typeof data.requestId === 'string') {
          ui.editor.graph.stopEditing(false);
          const current = snapshot();
          if (data.generation !== current.generation || data.expectedXml !== current.xml) {
            parent.postMessage(
              JSON.stringify({
                event: 'diagram-applied',
                requestId: data.requestId,
                status: 'conflict',
              }),
              '*',
            );
            return;
          }
          let started = false;
          try {
            if (
              typeof data.xml !== 'string' ||
              new TextEncoder().encode(data.xml).length > 1024 * 1024 ||
              /<!DOCTYPE|<!ENTITY/i.test(data.xml) ||
              !ui.isFileDataLoadable(data.xml)
            )
              throw new Error('Invalid XML');
            // Pinned draw.io replacement is one undoable transaction, including
            // page removal/insertion. It preserves the existing undo manager.
            started = true;
            ui.replaceFileData(data.xml);
            ui.editor.setModified(true);
            parent.postMessage(
              JSON.stringify({
                event: 'diagram-applied',
                requestId: data.requestId,
                status: 'applied',
                ...snapshot(),
              }),
              '*',
            );
          } catch {
            parent.postMessage(
              JSON.stringify({
                event: 'diagram-applied',
                requestId: data.requestId,
                status: started ? 'unknown' : 'failed',
              }),
              '*',
            );
          }
        }
        if (
          data.action === 'diagram-commit' &&
          typeof data.requestId === 'string' &&
          data.requestId.length <= 128
        ) {
          ui.editor.graph.stopEditing(false);
          parent.postMessage(
            JSON.stringify({ event: 'diagram-committed', requestId: data.requestId }),
            '*',
          );
        }
      } catch {
        /* Ignore other embed protocol messages. */
      }
    });
  };
  const addItems = Menus.prototype.addMenuItems;
  Menus.prototype.addMenuItems = function (menu, keys, ...rest) {
    return addItems.call(
      this,
      menu,
      keys.filter(key => key !== 'print'),
      ...rest,
    );
  };
  const addSubmenu = Menus.prototype.addSubmenu;
  Menus.prototype.addSubmenu = function (name, ...args) {
    if (name !== 'help') return addSubmenu.call(this, name, ...args);
  };
})();
