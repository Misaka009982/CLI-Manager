// Portal 仍沿 React 树冒泡；只隔离传播，保留默认焦点、按钮激活与 Esc 收尾。
const stopPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation();
// 箭头不是文件落点；阻止根目录移动和浏览器默认打开被拖入的文件。
const ignoreFileDrop = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
  event.stopPropagation();
  event.preventDefault();
};

export const folderTreeSortEvents = {
  onPointerDown: stopPropagation,
  onPointerMove: stopPropagation,
  onPointerUp: stopPropagation,
  onPointerCancel: stopPropagation,
  onClick: stopPropagation,
  onDoubleClick: stopPropagation,
  onContextMenu: stopPropagation,
  onKeyDown: stopPropagation,
  onKeyUp: stopPropagation,
  onDragStart: stopPropagation,
  onDrag: stopPropagation,
  onDragEnd: stopPropagation,
  onDragOver: ignoreFileDrop,
  onDrop: ignoreFileDrop,
};
