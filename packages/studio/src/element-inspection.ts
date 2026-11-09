import type { StudioElementInspection } from "@velocast/core";
export type ElementInspection = StudioElementInspection;

/** Read-only inspection; highlighting belongs to the parent, outside rendered pixels. */
export function inspectElement(
  document: Document,
  selector: string,
  target?: string,
): ElementInspection {
  if (!selector.trim() || selector.length > 2048)
    throw new Error(
      "studio.selector_invalid: enter a CSS selector up to 2048 characters",
    );
  let element: Element | null;
  let matchCount: number;
  try {
    const root = target ? document.querySelector(target) : document.body;
    matchCount =
      (root?.matches(selector) ? 1 : 0) +
      (root?.querySelectorAll(selector).length ?? 0);
    element = root?.matches(selector)
      ? root
      : (root?.querySelector(selector) ?? null);
  } catch {
    throw new Error("studio.selector_invalid: invalid CSS selector");
  }
  if (!element)
    throw new Error(
      "studio.element_missing: no element matches this selector at the selected frame",
    );
  const box = element.getBoundingClientRect();
  const computed = document.defaultView!.getComputedStyle(element);
  const source = element
    .closest("[data-velocast-source]")
    ?.getAttribute("data-velocast-source");
  const styles: Record<string, string> = {};
  for (const name of [
    "display",
    "position",
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "opacity",
    "transform",
    "overflow",
    "visibility",
    "z-index",
    "font-style",
    "letter-spacing",
    "text-align",
    "border-radius",
    "width",
    "height",
  ])
    styles[name] = computed.getPropertyValue(name);
  const layer = element.closest("[data-velocast-layer]");
  const parent = layer?.parentElement?.closest("[data-velocast-layer]");
  let depth = 0;
  for (
    let ancestor = parent;
    ancestor;
    ancestor = ancestor.parentElement?.closest("[data-velocast-layer]") ?? null
  )
    depth++;
  return {
    selector,
    matchCount,
    tag: element.tagName.toLowerCase(),
    text: (element.textContent ?? "").trim().slice(0, 500),
    ...(source ? { source } : {}),
    ...(layer
      ? {
          elementId: layer.getAttribute("data-velocast-layer")!,
          ...(parent
            ? { parentElementId: parent.getAttribute("data-velocast-layer")! }
            : {}),
          depth,
          childCount: [
            ...layer.querySelectorAll("[data-velocast-layer]"),
          ].filter(
            (child) =>
              child.parentElement?.closest("[data-velocast-layer]") === layer,
          ).length,
        }
      : {}),
    bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
    styles,
  };
}
