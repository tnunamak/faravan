// Closing a native modal must release inertness before its opener can receive focus.
export function focusOutcome() {
  const notice = document.querySelector('.notice');
  const target = notice?.textContent?.trim() ? notice : document.querySelector('h1') ?? document.querySelector('main');
  if (!target) return;
  target.tabIndex = -1;
  target.focus({preventScroll:true});
}
function canRestoreFocus(target) {
  if (!target?.isConnected || target.disabled || typeof target.focus !== 'function') return false;
  if (target.matches?.(':disabled')) return false;
  const view = target.ownerDocument?.defaultView;
  // Visibility is inherited but descendants can override it; use the effective target value.
  const visibility = view?.getComputedStyle?.(target)?.visibility;
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  for (let node = target; node; node = node.parentElement) {
    if (node.hidden || node.inert || node.hasAttribute?.('hidden') || node.hasAttribute?.('inert')) return false;
    const style = view?.getComputedStyle?.(node);
    if (style?.display === 'none') return false;
  }
  return true;
}
export function restoreFocus(trigger) {
  requestAnimationFrame(() => {
    if (canRestoreFocus(trigger)) {
      try {
        trigger.focus({preventScroll:true});
        if (document.activeElement === trigger) return;
      } catch {
        // A stale or unavailable focus target must not suppress the outcome.
      }
    }
    focusOutcome();
  });
}
