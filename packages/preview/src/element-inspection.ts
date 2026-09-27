export interface ElementInspection {
  selector: string;
  tag: string;
  text: string;
  source?: string;
  bounds: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
}

/** Read-only inspection; highlighting belongs to the parent, outside rendered pixels. */
export function inspectElement(
  document: Document,
  selector: string,
  target?: string,
): ElementInspection {
  if (!selector.trim() || selector.length > 2048)
    throw new Error(
      "preview.selector_invalid: enter a CSS selector up to 2048 characters",
    );
  let element: Element | null;
  try {
    const root = target ? document.querySelector(target) : document.body;
    element = root?.matches(selector)
      ? root
      : (root?.querySelector(selector) ?? null);
  } catch {
    throw new Error("preview.selector_invalid: invalid CSS selector");
  }
  if (!element)
    throw new Error(
      "preview.element_missing: no element matches this selector at the selected frame",
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
  ])
    styles[name] = computed.getPropertyValue(name);
  return {
    selector,
    tag: element.tagName.toLowerCase(),
    text: (element.textContent ?? "").trim().slice(0, 500),
    ...(source ? { source } : {}),
    bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
    styles,
  };
}
