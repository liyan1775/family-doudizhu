export interface HandPoint {
  x: number;
  y: number;
}

export interface HandCardArea {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 使用牌角的布局位置命中，避免牌抬起后在手指下面反复选中／取消。 */
export function cardAtPoint(areas: HandCardArea[], point: HandPoint): string | null {
  const hit = (lift: number) =>
    areas.find(
      (area) =>
        point.x >= area.left &&
        point.x < area.left + area.width &&
        point.y >= area.top - lift &&
        point.y < area.top + area.height,
    )?.id;
  return hit(0) ?? hit(7) ?? null;
}

/** 把屏幕坐标还原到手牌区；竖屏牌桌顺时针旋转90度，滚动值仍使用布局坐标。 */
export function handPoint(
  client: HandPoint,
  bounds: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
  rotated: boolean,
  scrollTop: number,
  clip = true,
): HandPoint | null {
  const x = client.x - bounds.left;
  const y = client.y - bounds.top;
  if (clip && (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height)) return null;
  return rotated
    ? {
        x: (y / bounds.height) * size.width,
        y: ((bounds.width - x) / bounds.width) * size.height + scrollTop,
      }
    : {
        x: (x / bounds.width) * size.width,
        y: (y / bounds.height) * size.height + scrollTop,
      };
}

/** 一次手势从初始选择计算范围，回划可缩短范围，已选的起牌表示取消。 */
export class HandSwipe {
  readonly initial: string[];
  status: 'pending' | 'selecting' | 'scrolling' = 'pending';
  private readonly anchor: number;
  private readonly selecting: boolean;

  constructor(
    private readonly ids: string[],
    initial: string[],
    anchorId: string,
    private readonly start: HandPoint,
  ) {
    this.initial = [...initial];
    this.anchor = ids.indexOf(anchorId);
    this.selecting = !initial.includes(anchorId);
  }

  move(point: HandPoint, endId: string | null): string[] | null {
    if (this.anchor < 0 || this.status === 'scrolling') return null;
    if (this.status === 'pending') {
      const along = Math.abs(point.x - this.start.x);
      const across = Math.abs(point.y - this.start.y);
      if (Math.max(along, across) < 6) return null;
      if (across > along) {
        this.status = 'scrolling';
        return null;
      }
      this.status = 'selecting';
    }
    const end = endId === null ? -1 : this.ids.indexOf(endId);
    if (end < 0) return null;
    const from = Math.min(this.anchor, end);
    const to = Math.max(this.anchor, end);
    const initial = new Set(this.initial);
    return this.ids.filter((id, index) =>
      index >= from && index <= to ? this.selecting : initial.has(id),
    );
  }
}
