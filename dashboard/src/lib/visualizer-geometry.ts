export type BarGeometry = {
  barWidth: number;
  gap: number;
  radius: number;
};

const MIN_BAR_WIDTH = 1;
const MAX_RADIUS = 3;

export function computeBarGeometry(width: number, bands: number, preferredGap: number): BarGeometry | null {
  if (!Number.isFinite(width) || width <= 0) return null;
  if (!Number.isFinite(bands) || bands < 1) return null;

  const safeBands = Math.floor(bands);
  const gaps = Math.max(0, safeBands - 1);
  const requestedGap = Math.max(0, Number.isFinite(preferredGap) ? preferredGap : 0);

  let gap = requestedGap;
  let barWidth = gaps > 0 ? (width - (gap * gaps)) / safeBands : width / safeBands;

  if (barWidth < MIN_BAR_WIDTH && gaps > 0) {
    gap = Math.max(0, (width - (MIN_BAR_WIDTH * safeBands)) / gaps);
    barWidth = (width - (gap * gaps)) / safeBands;
  }

  if (!Number.isFinite(barWidth) || barWidth <= 0) return null;

  return {
    barWidth,
    gap,
    radius: Math.max(0, Math.min(barWidth / 2, MAX_RADIUS)),
  };
}
