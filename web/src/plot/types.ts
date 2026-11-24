export type XMode = 'step' | 'wall' | 'rel';

export interface PlotSettings {
  /** EMA weight in [0, 0.99] */
  smoothing: number;
  xMode: XMode;
  logY: boolean;
  /** ignore the top and bottom pct % of values for the y range */
  clipPct: number;
  /** points per series requested for an unzoomed panel */
  maxPoints: number;
}

export interface RunInfo {
  id: number;
  name: string;
  color: string;
  /** fallback start time (unix seconds) for relative time */
  startTs?: number | null;
  /** metric key of this line when it differs from the panel's (compare view: one line per metric × run) */
  key?: string;
  /** canvas dash pattern for the line (compare view: one pattern per metric) */
  dash?: number[];
}

export interface PanelOverrides {
  smoothing: number | null;
  logY: boolean | null;
}
