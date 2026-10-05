import { useLayoutEffect, useRef, type RefObject } from 'react';
import {
  cardAtPoint,
  handPoint,
  HandSwipe,
  type HandCardArea,
  type HandPoint,
} from './hand-selection.js';

interface HandSwipeOptions {
  selected: string[];
  onChange?: (ids: string[]) => void;
  compact: boolean;
  resetKey: string;
}

export function useHandSwipe(
  scrollRef: RefObject<HTMLDivElement | null>,
  options: HandSwipeOptions,
) {
  const latest = useRef(options);
  latest.current = options;
  const enabled = !!options.onChange;
  // 跨重排／回合保留拦截，直到真正的新点按；长按后迟到的click也不能复活旧手势。
  const suppressPointerClick = useRef(false);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !enabled) return;
    return bindHandSwipe(element, latest, suppressPointerClick);
  }, [scrollRef, enabled, options.resetKey]);
}

export function bindHandSwipe(
  element: HTMLDivElement,
  latest: { current: HandSwipeOptions },
  suppressPointerClick: { current: boolean },
) {
  // 安卓微信可能没有完整的指针事件流；手指优先走触摸事件，鼠标／笔保留指针路径。
  const preferTouch = 'ontouchstart' in window || typeof TouchEvent !== 'undefined';
  let gesture: {
    source: 'pointer' | 'touch';
    id: number;
    anchorId: string;
    swipe: HandSwipe;
    areas: HandCardArea[];
    rotated: boolean;
    bounds: DOMRect;
    size: { width: number; height: number };
    start: HandPoint;
    scrollTop: number;
  } | null = null;

  function stop(restore: boolean) {
    const previous = gesture;
    gesture = null;
    if (!previous) return;
    if (previous.source === 'touch' || restore || previous.swipe.status !== 'pending')
      suppressPointerClick.current = true;
    if (restore && previous.swipe.status === 'selecting')
      latest.current.onChange?.(previous.swipe.initial);
    if (previous.source === 'pointer' && element.hasPointerCapture(previous.id))
      element.releasePointerCapture(previous.id);
  }

  function begin(
    source: 'pointer' | 'touch',
    id: number,
    target: EventTarget | null,
    client: HandPoint,
  ) {
    const button = target instanceof Element ? target.closest('button[data-card-id]') : null;
    if (!button || !element.contains(button)) return false;
    const areas = Array.from(
      element.querySelectorAll<HTMLButtonElement>('button[data-card-id]'),
    ).map((card) => ({
      id: card.dataset.cardId!,
      left: card.offsetLeft,
      top: card.offsetTop,
      width: card.offsetWidth,
      height: card.offsetHeight,
    }));
    const rotated = latest.current.compact && window.matchMedia('(orientation: portrait)').matches;
    const bounds = element.getBoundingClientRect();
    const size = { width: element.offsetWidth, height: element.offsetHeight };
    const scrollTop = element.scrollTop;
    const point = handPoint(client, bounds, size, rotated, scrollTop);
    if (!point) return false;
    const anchorId = button.getAttribute('data-card-id')!;
    suppressPointerClick.current = false;
    gesture = {
      source,
      id,
      anchorId,
      swipe: new HandSwipe(
        areas.map((area) => area.id),
        latest.current.selected,
        anchorId,
        point,
      ),
      areas,
      rotated,
      bounds,
      size,
      start: point,
      scrollTop,
    };
    return true;
  }

  function update(client: HandPoint) {
    if (!gesture) return;
    const current = gesture;
    const scrollTop = current.source === 'touch' ? current.scrollTop : element.scrollTop;
    // 手指越过手牌边缘时仍可继续滚动，但不能命中视口外的牌。
    const point = handPoint(
      client,
      current.bounds,
      current.size,
      current.rotated,
      scrollTop,
      false,
    )!;
    const inside = handPoint(client, current.bounds, current.size, current.rotated, scrollTop);
    const next = current.swipe.move(point, inside && cardAtPoint(current.areas, point));
    if (current.source === 'touch' && current.swipe.status === 'scrolling') {
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.max(0, Math.min(max, current.scrollTop + current.start.y - point.y));
    }
    if (next) latest.current.onChange?.(next);
  }

  function startPointer(event: PointerEvent) {
    if (gesture?.source === 'touch' || (preferTouch && event.pointerType === 'touch')) return;
    if (!event.isPrimary) {
      if (gesture) stop(true);
      return;
    }
    if (gesture || event.button !== 0) return;
    begin('pointer', event.pointerId, event.target, { x: event.clientX, y: event.clientY });
  }

  function movePointer(event: PointerEvent) {
    if (gesture?.source !== 'pointer' || event.pointerId !== gesture.id) return;
    update({ x: event.clientX, y: event.clientY });
    if (gesture?.swipe.status === 'selecting') {
      // 只在确定滑选后捕获指针，鼠标点选仍由牌按钮的click处理。
      if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId);
      if (event.cancelable) event.preventDefault();
    }
  }

  function finishPointer(event: PointerEvent) {
    if (gesture?.source !== 'pointer' || event.pointerId !== gesture.id) return;
    movePointer(event);
    stop(false);
  }

  function cancelPointer(event: PointerEvent) {
    if (gesture?.source !== 'pointer' || event.pointerId !== gesture.id) return;
    // 捕获转交给手牌区时，旧按钮的lost会冒泡，不能取消新捕获。
    if (event.type === 'lostpointercapture' && event.target !== element) return;
    stop(true);
  }

  function startTouch(event: TouchEvent) {
    if (event.touches.length !== 1) {
      stop(true);
      return;
    }
    if (gesture?.source === 'touch') return;
    // 部分内核会先发出没有pointerType的pointerdown，交给触摸路径接管。
    if (gesture) stop(true);
    const touch = event.changedTouches[0];
    if (
      touch &&
      begin('touch', touch.identifier, event.target, { x: touch.clientX, y: touch.clientY })
    ) {
      // 从起点声明手势归属，避免浏览器先滚动再取消滑选；单点由touchend处理。
      if (event.cancelable) event.preventDefault();
    }
  }

  function multipleTouches(event: TouchEvent) {
    if (gesture && event.touches.length > 1) stop(true);
  }

  function moveTouch(event: TouchEvent) {
    if (gesture?.source !== 'touch') return;
    if (event.cancelable) event.preventDefault();
    if (event.touches.length !== 1) {
      stop(true);
      return;
    }
    const touch = Array.from(event.touches).find((touch) => touch.identifier === gesture?.id);
    if (touch) update({ x: touch.clientX, y: touch.clientY });
  }

  function finishTouch(event: TouchEvent) {
    if (gesture?.source !== 'touch') return;
    const touch = Array.from(event.changedTouches).find(
      (touch) => touch.identifier === gesture?.id,
    );
    if (!touch) return;
    if (event.cancelable) event.preventDefault();
    update({ x: touch.clientX, y: touch.clientY });
    if (gesture?.swipe.status === 'pending') {
      const { initial } = gesture.swipe;
      const { anchorId } = gesture;
      latest.current.onChange?.(
        initial.includes(anchorId)
          ? initial.filter((id) => id !== anchorId)
          : [...initial, anchorId],
      );
    }
    stop(false);
  }

  function cancel() {
    stop(true);
  }
  function scroll() {
    // 手指横跨牌行时由本手势滚动，scroll事件不能取消它自己。
    if (gesture?.source === 'touch' && gesture.swipe.status === 'scrolling') return;
    cancel();
  }
  function visibility() {
    if (document.hidden) cancel();
  }
  function click(event: MouseEvent) {
    // 触摸结束的兼容click不能重复切换牌；键盘／读屏的click继续可用。
    if (
      event.detail !== 0 &&
      (gesture?.source === 'touch' ||
        gesture?.swipe.status === 'selecting' ||
        suppressPointerClick.current)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function contextMenu(event: Event) {
    if (gesture) event.preventDefault();
  }

  element.addEventListener('pointerdown', startPointer);
  window.addEventListener('pointermove', movePointer, { passive: false });
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', cancelPointer);
  element.addEventListener('lostpointercapture', cancelPointer);
  element.addEventListener('touchstart', startTouch, { passive: false });
  window.addEventListener('touchstart', multipleTouches, { passive: false });
  window.addEventListener('touchmove', moveTouch, { passive: false });
  window.addEventListener('touchend', finishTouch, { passive: false });
  window.addEventListener('touchcancel', cancel);
  element.addEventListener('click', click, true);
  element.addEventListener('contextmenu', contextMenu);
  element.addEventListener('scroll', scroll);
  window.addEventListener('blur', cancel);
  window.addEventListener('resize', cancel);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    // 换轮、掉线、重排或卸载后只丢弃手势，不把上一回合的选择写回去。
    if (gesture) suppressPointerClick.current = true;
    stop(false);
    element.removeEventListener('pointerdown', startPointer);
    window.removeEventListener('pointermove', movePointer);
    window.removeEventListener('pointerup', finishPointer);
    window.removeEventListener('pointercancel', cancelPointer);
    element.removeEventListener('lostpointercapture', cancelPointer);
    element.removeEventListener('touchstart', startTouch);
    window.removeEventListener('touchstart', multipleTouches);
    window.removeEventListener('touchmove', moveTouch);
    window.removeEventListener('touchend', finishTouch);
    window.removeEventListener('touchcancel', cancel);
    element.removeEventListener('click', click, true);
    element.removeEventListener('contextmenu', contextMenu);
    element.removeEventListener('scroll', scroll);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('resize', cancel);
    document.removeEventListener('visibilitychange', visibility);
  };
}
