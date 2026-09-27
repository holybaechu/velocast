export interface TemplateCatalogEntry {
  id: "react-static" | "lyrics";
  title: string;
  description: string;
  compositionId: string;
  workflow: string[];
}

export const TEMPLATE_CATALOG: readonly TemplateCatalogEntry[] = Object.freeze([
  {
    id: "react-static",
    title: "React composition",
    description: "Small frame-derived React composition with local artwork.",
    compositionId: "hello-react",
    workflow: ["build", "preview", "render"],
  },
  {
    id: "lyrics",
    title: "Timed lyrics",
    description:
      "1920x1080 frame-derived lyrics layout with empty validated cue data and audit assertions.",
    compositionId: "lyrics-starter",
    workflow: [
      "init --audio/--lyrics",
      "transcript import",
      "analyze-audio",
      "check",
      "preview",
      "render",
    ],
  },
]);

export function templatesCommand(
  options: { json?: boolean; write?: (text: string) => void } = {},
): void {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (options.json)
    write(`${JSON.stringify({ templates: TEMPLATE_CATALOG }, null, 2)}\n`);
  else
    for (const template of TEMPLATE_CATALOG)
      write(
        `${template.id}: ${template.title}\n  ${template.description}\n  ${template.workflow.join(" -> ")}\n`,
      );
}
