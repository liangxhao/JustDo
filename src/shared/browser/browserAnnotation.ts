export type BrowserPanelRect = { x: number; y: number; width: number; height: number };

export type BrowserInspectedElement = {
  tag: string;
  id: string;
  classes: string[];
  role: string;
  name: string;
  rect: BrowserPanelRect;
  focusable: boolean;
  cssPath: string;
  computedStyle?: BrowserInspectedElementStyle;
};

export type BrowserInspectedElementStyle = {
  color: string;
  backgroundColor: string;
  opacity: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  display: string;
  position: string;
  zIndex: string;
  borderRadius: string;
};

export type BrowserAnnotationPoint = { x: number; y: number };
export type BrowserAnnotationStroke = { points: BrowserAnnotationPoint[] };
export type BrowserAnnotationRegion = BrowserPanelRect & {
  elements?: BrowserInspectedElement[];
};

export type BrowserAnnotationElementSummary = {
  tag: string;
  id: string;
  classes: string[];
  role: string;
  name: string;
  cssPath: string;
  rect: BrowserPanelRect;
};

export type BrowserAnnotationDisplay = {
  id: string;
  title: string;
  displayUrl: string;
  markedRegionCount: number;
  comment?: string;
  element?: BrowserAnnotationElementSummary;
};

export type BrowserAnnotationDraft = {
  id: string;
  modelContext: string;
  title: string;
  displayUrl: string;
  markedRegionCount: number;
  inspectedElement: boolean;
  comment?: string;
  display?: BrowserAnnotationDisplay;
  dataUrl: string;
  fileName: string;
  addedAt: number;
};
