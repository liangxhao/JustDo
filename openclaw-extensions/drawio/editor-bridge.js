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
    window.addEventListener('message', event => {
      if (event.source !== parent || typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data);
        if (data.action === 'diagram-theme' && typeof data.dark === 'boolean')
          ui.setDarkMode(data.dark);
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
