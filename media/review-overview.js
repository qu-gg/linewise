/**
 * @typedef {{ kind: 'added' | 'removed', top: number, height: number }} OverviewMarkerInput
 * @typedef {{ kind: 'added' | 'removed', top: number, height: number }} OverviewMarker
 * @typedef {{ markers: OverviewMarker[], thumb: { top: number, height: number } }} OverviewGeometry
 */

const clamp = (value, minimum, maximum) =>
  Math.min(Math.max(Number.isFinite(value) ? value : minimum, minimum), maximum);
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/**
 * @param {readonly OverviewMarkerInput[]} markers
 * @param {number} contentHeight
 * @param {number} viewportHeight
 * @param {number} scrollTop
 * @param {number} [minimumMarkerHeight]
 * @returns {OverviewGeometry}
 */
export function overviewGeometry(
  markers,
  contentHeight,
  viewportHeight,
  scrollTop,
  minimumMarkerHeight = 2,
) {
  const total = Math.max(1, finite(contentHeight, 1));
  const viewport = clamp(finite(viewportHeight), 0, total);
  const maximumScroll = Math.max(0, total - viewport);
  const scroll = clamp(finite(scrollTop), 0, maximumScroll);
  const minimum = Math.max(0, finite(minimumMarkerHeight));
  return {
    markers: markers
      .filter((marker) => marker.height > 0 && marker.top < total)
      .map((marker) => {
        const top = clamp(finite(marker.top), 0, total) / total;
        const height = Math.min(
          Math.max(finite(marker.height), minimum) / total,
          Math.max(0, 1 - top),
        );
        return { kind: marker.kind, top, height };
      }),
    thumb: {
      top: viewport >= total ? 0 : scroll / total,
      height: viewport >= total ? 1 : Math.max(viewport / total, 1 / total),
    },
  };
}

/**
 * @param {number} ratio
 * @param {number} contentHeight
 * @param {number} viewportHeight
 * @returns {number}
 */
export function scrollTopForOverview(ratio, contentHeight, viewportHeight) {
  const total = Math.max(1, finite(contentHeight, 1));
  const viewport = clamp(finite(viewportHeight), 0, total);
  const maximumScroll = Math.max(0, total - viewport);
  return clamp(clamp(ratio, 0, 1) * total - viewport / 2, 0, maximumScroll);
}
