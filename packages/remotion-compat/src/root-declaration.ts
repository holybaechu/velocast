import type { ComponentType } from "react";

let registeredRoot: ComponentType | undefined;

/** Records the unchanged source root. The host still supplies an explicit manifest. */
export function registerRoot(root: ComponentType): void {
  if (typeof root !== "function")
    throw new TypeError("VELOCAST_REMOTION_ROOT_INVALID: registerRoot expects a React component");
  if (registeredRoot && registeredRoot !== root)
    throw new Error("VELOCAST_REMOTION_ROOT_DUPLICATE: a different root is already registered");
  registeredRoot = root;
}

export function assertRegisteredRoot(root: ComponentType): void {
  if (!registeredRoot)
    throw new Error("VELOCAST_REMOTION_ROOT_MISSING: import the unchanged entry module before binding its explicit host manifest");
  if (registeredRoot !== root)
    throw new Error("VELOCAST_REMOTION_ROOT_MISMATCH: host manifest root does not match registerRoot()");
}

export function Composition(_props: Record<string, unknown>): never {
  void _props;
  throw new Error(
    "VELOCAST_REMOTION_MANIFEST_REQUIRED: Composition JSX is declaration input; bind the component and metadata explicitly with registerRemotionComposition()",
  );
}
