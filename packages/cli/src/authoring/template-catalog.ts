import type { ProjectTemplate } from "./templates/project.js";
export interface TemplateCatalogEntry {
  id: ProjectTemplate;
  title: string;
  description: string;
  compositionId: string;
  workflow: string[];
  requirements: readonly string[];
  compositions: readonly { id: string; description: string }[];
  editableFiles: readonly string[];
  inputs?: { file: string; description: string };
  examples: readonly string[];
}
const requirements = [
  "Node.js ^22.22.2, ^24.15.0, or >=26.0.0",
  "Matching Velocast packages from your package source",
  "Working native renderer and Electron runtime for inspect/frame/render",
] as const;
export const TEMPLATE_CATALOG: readonly TemplateCatalogEntry[] = [
  {
    id: "product-demo",
    title: "Product demo (default)",
    description:
      "React source with a 30-second product video, local music and a portrait motion graphic; Studio edits supported source literals.",
    compositionId: "product-demo",
    workflow: ["build", "studio", "frame", "render", "verify"],
    requirements,
    compositions: [
      {
        id: "product-demo",
        description:
          "960x540, 30fps, 900 frames; three scenes and full-length audio",
      },
      {
        id: "social-card",
        description: "540x960, 30fps, 150 frames; custom SVG motion graphic",
      },
    ],
    editableFiles: [
      "src/product-demo.jsx",
      "src/social-card.jsx",
      "public/assets/overview.svg",
      "public/assets/detail.svg",
      "src/main.jsx",
    ],
    examples: [
      "velocast init my-video",
      "npm install",
      "npm run studio",
      "npm run frame",
      "npm run render",
      "npm run verify",
    ],
  },
  {
    id: "blank",
    title: "Blank video",
    description:
      "A ten-second React composition with one source-editable title.",
    compositionId: "video",
    workflow: ["build", "studio", "render", "verify"],
    requirements,
    compositions: [
      {
        id: "video",
        description:
          "960x540, 30fps, 300 frames; ordinary React with an editable Layer",
      },
    ],
    editableFiles: ["src/video.jsx", "src/main.jsx"],
    examples: [
      "velocast init my-video --template blank",
      "npm install",
      "npm run studio",
      "npm run render",
    ],
  },
  {
    id: "editable-project",
    title: "Structured project",
    description:
      "Optional JSON authoring with scenes, layers and media import in Studio.",
    compositionId: "product-demo",
    workflow: ["build", "studio", "frame", "render", "verify"],
    requirements,
    compositions: [
      {
        id: "product-demo",
        description: "960x540, 30fps, 900 frames; three scenes and music",
      },
    ],
    editableFiles: ["project.json", "src/main.jsx"],
    inputs: {
      file: "project.json",
      description:
        "Validated VideoProject document selected by config.inputPropsFile.",
    },
    examples: [
      "velocast init my-video --template editable-project",
      "npm install",
      "npm run studio",
    ],
  },
];

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
