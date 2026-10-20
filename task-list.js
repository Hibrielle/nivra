// Retain keyed task nodes so progress transitions, selection and focus survive polling.
const state = new WeakMap();
const running = new Set();
let motion;
function motionPreference() {
  if (!motion) {
    motion = matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change', () => {
      if (motion.matches) for (const animation of running) animation.cancel();
    });
  }
  return motion;
}

const keyOf = (node) => (node.nodeType === 1 ? node.getAttribute('data-task-key') : null);
const compatible = (a, b) =>
  a && a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

function patch(node, next) {
  if (node.nodeType === 3) {
    if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
    return;
  }
  if (node.nodeType === 1) {
    for (const attribute of [...node.attributes])
      if (!next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
    for (const attribute of next.attributes)
      if (node.getAttribute(attribute.name) !== attribute.value)
        node.setAttribute(attribute.name, attribute.value);
  }
  const keyed = new Map(
    [...node.childNodes]
      .filter((child) => keyOf(child) !== null)
      .map((child) => [keyOf(child), child]),
  );
  let cursor = node.firstChild;
  for (const desired of next.childNodes) {
    let current = keyOf(desired) !== null ? keyed.get(keyOf(desired)) : cursor;
    if (!compatible(current, desired)) {
      current = desired.cloneNode(true);
      node.insertBefore(current, cursor);
    } else {
      if (current !== cursor) node.insertBefore(current, cursor);
      patch(current, desired);
    }
    cursor = current.nextSibling;
  }
  while (cursor) {
    const nextSibling = cursor.nextSibling;
    cursor.remove();
    cursor = nextSibling;
  }
}

function animate(element, frames, options) {
  if (!element) return;
  for (const animation of element.getAnimations()) animation.cancel();
  const animation = element.animate(frames, options);
  running.add(animation);
  animation.finished.catch(() => {}).finally(() => running.delete(animation));
}

export function renderTaskList(container, markup, context = '') {
  const previous = state.get(container);
  const focused = container.contains(document.activeElement) ? document.activeElement : null;
  const scroll = { top: container.scrollTop, left: container.scrollLeft };
  const template = document.createElement('template');
  template.innerHTML = markup;
  // The container's own attributes belong to its caller; only reconcile children.
  const shell = container.cloneNode(false);
  shell.append(template.content);
  patch(container, shell);
  container.scrollTop = scroll.top;
  container.scrollLeft = scroll.left;
  if (focused?.isConnected && document.activeElement !== focused)
    focused.focus({ preventScroll: true });
  const rows = [...container.querySelectorAll('[data-task-key]')];
  const states = new Map(rows.map((row) => [row.dataset.taskKey, row.dataset.taskState]));
  state.set(container, { context, states });
  if (!previous || previous.context !== context || document.hidden || motionPreference().matches)
    return;
  const styles = getComputedStyle(container);
  const options = {
    duration: parseFloat(styles.getPropertyValue('--dur-base')) || 180,
    easing: styles.getPropertyValue('--ease').trim() || 'ease-out',
  };
  for (const row of rows) {
    const before = previous.states.get(row.dataset.taskKey);
    if (before === undefined) {
      animate(
        row,
        [
          { opacity: 0, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        options,
      );
    } else if (before !== row.dataset.taskState) {
      animate(
        row.querySelector('.task-status-badge') || row.querySelector('.task-file-glyph'),
        [
          { opacity: 0, transform: 'scale(0.92)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        options,
      );
    }
  }
}
