/** 在可用手牌区内均匀分行；保留可读的牌角，过矮时才允许内部滚动。 */
export function handLayout(count: number, width: number, height: number, landscape = false) {
  const cardWidth = width < 320 ? 45 : 54;
  const capacity = Math.max(1, Math.floor((width - cardWidth) / 23) + 1);
  const rows = Math.max(1, Math.ceil(count / capacity));
  const columns = Array.from(
    { length: rows },
    (_, row) => Math.floor(count / rows) + (row < count % rows ? 1 : 0),
  );
  const cardHeight = Math.max(
    landscape ? 42 : 50,
    Math.min(92, Math.floor((height - (rows - 1) * 4) / rows)),
  );
  const longest = Math.max(1, ...columns);
  const strip = longest > 1 ? (width - cardWidth) / (longest - 1) : cardWidth;
  const fontSize = Math.max(
    18,
    Math.min(25, Math.floor(strip - 3), Math.floor((cardHeight - 6) / 2)),
  );
  return { columns, cardWidth, cardHeight, fontSize };
}
