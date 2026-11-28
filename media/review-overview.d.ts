export interface OverviewMarkerInput {
  kind: 'added' | 'removed';
  top: number;
  height: number;
}

export interface OverviewMarker {
  kind: 'added' | 'removed';
  top: number;
  height: number;
}

export interface OverviewGeometry {
  markers: OverviewMarker[];
  thumb: { top: number; height: number };
}

export function overviewGeometry(
  markers: readonly OverviewMarkerInput[],
  contentHeight: number,
  viewportHeight: number,
  scrollTop: number,
  minimumMarkerHeight?: number,
): OverviewGeometry;

export function scrollTopForOverview(
  ratio: number,
  contentHeight: number,
  viewportHeight: number,
): number;
