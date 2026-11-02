/** A discovered source value and the literal-edit boundary for that field. */
export interface CodeField {
  value?: string | number | boolean;
  editable: boolean;
  reason?: string;
}

export interface CodeElement {
  id: string;
  name: string;
  kind: "layer" | "audio" | "video";
  /** One-based source line. */
  line: number;
  fields: Record<string, CodeField>;
}

/** Saved source state; a successful edit still needs a build and staged refresh. */
export interface CodeSource {
  enabled: boolean;
  compositionId: string;
  path?: string;
  revision?: string;
  /** Exact source revision recorded by the active frozen build, when tracked. */
  displayedRevision?: string;
  elements: CodeElement[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface CodeEdit {
  id: string;
  field: string;
  value: string | number | boolean;
}
