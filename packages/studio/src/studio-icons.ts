import type { IconNode } from "lucide";

/** Render imported Lucide nodes without depending on a global document. */
export function icon(nodes: IconNode): string {
  const attribute = (value: string | number) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${nodes
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => `${name}="${attribute(value!)}"`)
          .join(" ")} />`,
    )
    .join("")}</svg>`;
}
