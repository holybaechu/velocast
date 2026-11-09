import ts from "typescript";
import type { CodeEdit, CodeElement, CodeField } from "@velocast/core";
import {
  LAYER_ANIMATION_PROPERTIES,
  validateLayerAnimationTrack,
} from "@velocast/core";
import { StudioCodeError } from "./studio-code-config.js";

type Scalar = string | number | boolean;
interface Field {
  description: CodeField;
  write?: (value: Scalar) => Patch;
}
interface Patch {
  start: number;
  end: number;
  text: string;
}
interface Element {
  description: CodeElement;
  fields: Record<string, Field>;
}
const layerDefaults: Record<string, Scalar | undefined> = {
  name: undefined,
  from: 0,
  durationFrames: undefined,
  x: 0,
  y: 0,
  width: undefined,
  height: undefined,
  rotation: 0,
  opacity: 1,
};
const mediaDefaults: Record<string, Scalar | undefined> = {
  src: undefined,
  from: 0,
  durationFrames: undefined,
  trimBeforeFrames: 0,
  gain: 1,
  muted: false,
  fadeInFrames: 0,
  fadeOutFrames: 0,
};
const readonly = (reason: string, value?: Scalar): Field => ({
  description: {
    ...(value === undefined ? {} : { value }),
    editable: false,
    reason,
  },
});
const expressionReason =
  "Source values must be finite literals to edit here; computed values stay in source code";
const styleFields = ["color", "backgroundColor", "fontSize", "borderRadius"];
const geometryStyles: Record<string, string[]> = {
  x: ["left", "right", "inset", "transform", "translate"],
  y: ["top", "bottom", "inset", "transform", "translate"],
  width: ["width", "minWidth", "maxWidth", "inset", "transform", "scale"],
  height: ["height", "minHeight", "maxHeight", "inset", "transform", "scale"],
  rotation: ["transform", "rotate"],
  opacity: ["opacity"],
};

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  return node &&
    (ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node))
    ? node.text
    : undefined;
}

function repeated(node: ts.Node): boolean {
  for (
    let parent: ts.Node | undefined = node.parent;
    parent;
    parent = parent.parent
  ) {
    if (
      (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
      !ts.isVariableDeclaration(parent.parent)
    )
      return true;
    if (
      ts.isForStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isWhileStatement(parent)
    )
      return true;
    if (
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)
    )
      return true;
  }
  return false;
}

function binds(name: ts.BindingName, target: string): boolean {
  return ts.isIdentifier(name)
    ? name.text === target
    : name.elements.some(
        (element) =>
          ts.isBindingElement(element) && binds(element.name, target),
      );
}

function shadowed(reference: ts.Node): boolean {
  const base = ts.isIdentifier(reference)
    ? reference
    : ts.isPropertyAccessExpression(reference) &&
        ts.isIdentifier(reference.expression)
      ? reference.expression
      : undefined;
  if (!base) return false;
  const name = base.text;
  for (
    let scope: ts.Node | undefined = reference.parent;
    scope;
    scope = scope.parent
  ) {
    if (
      (ts.isFunctionDeclaration(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isArrowFunction(scope) ||
        ts.isMethodDeclaration(scope)) &&
      scope.parameters.some((parameter) => binds(parameter.name, name))
    )
      return true;
    if (
      ts.isCatchClause(scope) &&
      scope.variableDeclaration &&
      binds(scope.variableDeclaration.name, name)
    )
      return true;
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((declaration) =>
            binds(declaration.name, name),
          )
        )
          return true;
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name?.text === name
        )
          return true;
      }
    }
  }
  return false;
}

function duplicates(names: Array<string | undefined>): boolean {
  const defined = names.filter((name) => name !== undefined);
  return new Set(defined).size !== defined.length;
}

function jsxText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  let lastContent = 0;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastContent = index;
  });
  let result = "";
  lines.forEach((line, index) => {
    let value = line.replace(/\t/g, " ");
    if (index > 0) value = value.replace(/^ +/, "");
    if (index < lines.length - 1) value = value.replace(/ +$/, "");
    if (value) result += value + (index === lastContent ? "" : " ");
  });
  return result;
}

function scalar(node: ts.Node | undefined): Scalar | undefined {
  if (!node) return;
  if (ts.isParenthesizedExpression(node)) return scalar(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return ts.isJsxAttribute(node.parent) &&
      /&(?:#\w+|\w+);|\r|\n/.test(node.text)
      ? undefined
      : node.text;
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    return Number.isFinite(value) ? value : undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken ||
      node.operator === ts.SyntaxKind.PlusToken)
  ) {
    const value = scalar(node.operand);
    if (typeof value === "number")
      return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
}

/** Read literals without evaluating project expressions. */
function structuredLiteral(node: ts.Node | undefined): unknown {
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map(structuredLiteral);
    return values.includes(undefined) ? undefined : values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: [string, unknown][] = [];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const key = propertyName(property.name),
        value = structuredLiteral(property.initializer);
      if (
        key === undefined ||
        value === undefined ||
        entries.some(([name]) => name === key)
      )
        return undefined;
      entries.push([key, value]);
    }
    return Object.fromEntries(entries);
  }
  return scalar(node);
}

function parse(
  path: string,
  source: string,
): { file: ts.SourceFile; elements: Element[] } {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.ts$/i.test(path)
      ? ts.ScriptKind.TS
      : /\.tsx$/i.test(path)
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.JSX,
  );
  const diagnostics = (
    file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length) {
    const issue = diagnostics[0]!;
    const line = file.getLineAndCharacterOfPosition(issue.start ?? 0).line + 1;
    throw new StudioCodeError(
      400,
      "studio.code_syntax",
      `${path}:${line}: ${ts.flattenDiagnosticMessageText(issue.messageText, " ")}`,
    );
  }
  const layers = new Set<string>();
  const sequences = new Set<string>();
  const images = new Set<string>();
  const timelines = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@velocast/react"
    )
      continue;
    if (statement.importClause?.isTypeOnly) continue;
    const binding = statement.importClause?.namedBindings;
    if (binding && ts.isNamespaceImport(binding))
      namespaces.add(binding.name.text);
    if (binding && ts.isNamedImports(binding))
      for (const item of binding.elements) {
        if (item.isTypeOnly) continue;
        if ((item.propertyName ?? item.name).text === "Layer")
          layers.add(item.name.text);
        if ((item.propertyName ?? item.name).text === "Sequence")
          sequences.add(item.name.text);
        if ((item.propertyName ?? item.name).text === "StillImage")
          images.add(item.name.text);
        if ((item.propertyName ?? item.name).text === "createMediaTimeline")
          timelines.add(item.name.text);
      }
  }
  const isLayer = (node: ts.Node) =>
    ts.isIdentifier(node)
      ? layers.has(node.text)
      : ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        node.name.text === "Layer";
  const matches = (node: ts.Node, names: Set<string>, imported: string) =>
    ts.isIdentifier(node)
      ? names.has(node.text)
      : ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        node.name.text === imported;
  const elements: Element[] = [];
  const uses = new Map<string, number>();
  const repeatedComponents = new Set<string>();
  const countComponents = (node: ts.Node) => {
    if (ts.isCallExpression(node))
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument)) repeatedComponents.add(argument.text);
      }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName)
    ) {
      uses.set(node.tagName.text, (uses.get(node.tagName.text) ?? 0) + 1);
      if (repeated(node)) repeatedComponents.add(node.tagName.text);
    }
    ts.forEachChild(node, countComponents);
  };
  countComponents(file);
  const reused = (node: ts.Node) => {
    for (
      let scope: ts.Node | undefined = node.parent;
      scope;
      scope = scope.parent
    ) {
      const name = ts.isFunctionDeclaration(scope)
        ? scope.name?.text
        : (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) &&
            ts.isVariableDeclaration(scope.parent) &&
            ts.isIdentifier(scope.parent.name)
          ? scope.parent.name.text
          : undefined;
      if (name && ((uses.get(name) ?? 0) > 1 || repeatedComponents.has(name)))
        return true;
    }
    return false;
  };
  const replace = (node: ts.Node, text: string): Patch => ({
    start: node.getStart(file),
    end: node.end,
    text,
  });
  const appendProperty = (
    object: ts.ObjectLiteralExpression,
    name: string,
    value: Scalar,
  ): Patch => ({
    start: object.end - 1,
    end: object.end - 1,
    text: `${object.properties.length && !object.properties.hasTrailingComma ? "," : ""} ${name}: ${JSON.stringify(value)} `,
  });
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      matches(node.expression, timelines, "createMediaTimeline")
    ) {
      const clips = node.arguments[1];
      const computedArray =
        clips &&
        ts.isArrayLiteralExpression(clips) &&
        clips.elements.some((clip) => !ts.isObjectLiteralExpression(clip));
      const clipNodes =
        clips && ts.isArrayLiteralExpression(clips) ? clips.elements : [node];
      for (const clip of clipNodes) {
        const object = ts.isObjectLiteralExpression(clip) ? clip : undefined;
        const property = (name: string) =>
          object?.properties.find((item) => propertyName(item.name) === name);
        const value = (name: string) => {
          const item = property(name);
          return item && ts.isPropertyAssignment(item)
            ? scalar(item.initializer)
            : undefined;
        };
        const id = value("id");
        const kind = value("kind");
        const line =
          file.getLineAndCharacterOfPosition(clip.getStart(file)).line + 1;
        const reason = shadowed(node.expression)
          ? "This import name is shadowed by a local binding"
          : computedArray
            ? "Media arrays with spread or computed clips are controlled by source code"
            : !object
              ? "Media clips need an inline array of literal objects for source editing"
              : object.properties.some(
                    (item) =>
                      !ts.isPropertyAssignment(item) ||
                      propertyName(item.name) === undefined,
                  ) ||
                  duplicates(
                    object.properties.map((item) => propertyName(item.name)),
                  )
                ? "Media object spreads, duplicate or computed properties are controlled by source code"
                : typeof id !== "string" ||
                    !id.trim() ||
                    !["audio", "video"].includes(String(kind))
                  ? "Media clips need an inline string id and audio or video kind"
                  : repeated(node) || reused(node)
                    ? "Repeated media declarations are controlled by source code"
                    : undefined;
        const fields: Record<string, Field> = {};
        for (const [key, fallback] of Object.entries(mediaDefaults)) {
          const prop = property(key);
          const literal = value(key);
          fields[key] = reason
            ? readonly(reason, literal ?? fallback)
            : prop && literal === undefined
              ? readonly(expressionReason)
              : {
                  description: {
                    ...((literal ?? fallback) === undefined
                      ? {}
                      : { value: literal ?? fallback }),
                    editable: true,
                  },
                  write: (next) =>
                    prop && ts.isPropertyAssignment(prop)
                      ? replace(prop.initializer, JSON.stringify(next))
                      : appendProperty(object!, key, next),
                };
        }
        if (property("volumeEnvelope"))
          for (const key of ["fadeInFrames", "fadeOutFrames"])
            fields[key] = readonly(
              "The source volumeEnvelope controls this clip's fades",
              fields[key]!.description.value,
            );
        elements.push({
          description: {
            id: typeof id === "string" ? id : `source-media-${line}`,
            name: typeof id === "string" ? id : "Code-controlled media",
            kind: kind === "audio" ? "audio" : "video",
            line,
            fields: Object.fromEntries(
              Object.entries(fields).map(([key, field]) => [
                key,
                field.description,
              ]),
            ),
          },
          fields,
        });
      }
    }
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      isLayer(node.tagName)
    ) {
      const attrs = node.attributes.properties;
      const attr = (name: string) =>
        attrs.find(
          (item): item is ts.JsxAttribute =>
            ts.isJsxAttribute(item) && item.name.getText(file) === name,
        );
      const value = (item: ts.JsxAttribute | undefined) =>
        item?.initializer && ts.isJsxExpression(item.initializer)
          ? item.initializer.expression
          : item?.initializer;
      const id = scalar(value(attr("id")));
      const name = scalar(value(attr("name")));
      const line =
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const fields: Record<string, Field> = {};
      for (const [key, fallback] of Object.entries(layerDefaults)) {
        const attribute = attr(key);
        const literal = scalar(value(attribute));
        if (attribute && literal === undefined)
          fields[key] = readonly(expressionReason);
        else
          fields[key] = {
            description: {
              ...((literal ?? fallback) === undefined
                ? {}
                : { value: literal ?? fallback }),
              editable: true,
            },
            write: (next) =>
              attribute?.initializer
                ? replace(attribute.initializer, `{${JSON.stringify(next)}}`)
                : {
                    start: node.attributes.end,
                    end: node.attributes.end,
                    text: ` ${key}={${JSON.stringify(next)}}`,
                  },
          };
      }
      const styleAttr = attr("style");
      const style = value(styleAttr);
      const styleObject =
        style && ts.isObjectLiteralExpression(style) ? style : undefined;
      const styleReason =
        styleAttr &&
        (!styleObject ||
          styleObject.properties.some(
            (property) =>
              !ts.isPropertyAssignment(property) ||
              propertyName(property.name) === undefined,
          ) ||
          duplicates(
            styleObject.properties.map((item) => propertyName(item.name)),
          ))
          ? "Computed style objects, duplicate properties or spreads are controlled by source code"
          : undefined;
      for (const key of styleFields) {
        const property = styleObject?.properties.find(
          (item) => propertyName(item.name) === key,
        );
        const literal =
          property && ts.isPropertyAssignment(property)
            ? scalar(property.initializer)
            : undefined;
        fields[`style.${key}`] = styleReason
          ? readonly(styleReason, literal)
          : property && literal === undefined
            ? readonly(expressionReason)
            : {
                description: {
                  ...(literal === undefined ? {} : { value: literal }),
                  editable: true,
                },
                write: (next) =>
                  property && ts.isPropertyAssignment(property)
                    ? replace(property.initializer, JSON.stringify(next))
                    : styleObject
                      ? appendProperty(styleObject, key, next)
                      : {
                          start: node.attributes.end,
                          end: node.attributes.end,
                          text: ` style={{ ${key}: ${JSON.stringify(next)} }}`,
                        },
              };
      }
      for (const [key, overrides] of Object.entries(geometryStyles)) {
        if (
          styleReason ||
          styleObject?.properties.some((property) =>
            overrides.includes(propertyName(property.name) ?? ""),
          )
        )
          fields[key] = readonly(
            styleReason ?? `The style object overrides ${key}`,
            fields[key]!.description.value,
          );
      }
      const animationAttr = attr("animation");
      const animation = value(animationAttr);
      const animationObject =
        animation && ts.isObjectLiteralExpression(animation)
          ? animation
          : undefined;
      const animationReason =
        animationAttr &&
        (!animationObject ||
          animationObject.properties.some(
            (property) =>
              !ts.isPropertyAssignment(property) ||
              propertyName(property.name) === undefined,
          ) ||
          duplicates(
            animationObject.properties.map((property) =>
              propertyName(property.name),
            ),
          ))
          ? "Computed animation objects, duplicate properties or spreads stay code-controlled"
          : undefined;
      for (const property of LAYER_ANIMATION_PROPERTIES) {
        const assigned = animationObject?.properties.find(
          (item) => propertyName(item.name) === property,
        );
        const literal =
          assigned && ts.isPropertyAssignment(assigned)
            ? structuredLiteral(assigned.initializer)
            : null;
        const reason =
          animationReason ??
          (assigned && literal === undefined ? expressionReason : undefined) ??
          (styleReason ||
          styleObject?.properties.some((item) =>
            geometryStyles[property]!.includes(propertyName(item.name) ?? ""),
          )
            ? "The style object overrides this animation property"
            : undefined) ??
          (!assigned && !fields[property]!.description.editable
            ? fields[property]!.description.reason
            : undefined);
        fields[`animation.${property}`] = reason
          ? readonly(reason)
          : {
              description: { editable: true, value: JSON.stringify(literal) },
              write: (next) => {
                const text = String(next);
                if (assigned && ts.isPropertyAssignment(assigned))
                  return replace(assigned.initializer, text);
                if (text === "null")
                  return {
                    start: node.attributes.end,
                    end: node.attributes.end,
                    text: "",
                  };
                return animationObject
                  ? {
                      start: animationObject.end - 1,
                      end: animationObject.end - 1,
                      text: `${animationObject.properties.length && !animationObject.properties.hasTrailingComma ? "," : ""} ${property}: ${text} `,
                    }
                  : {
                      start: node.attributes.end,
                      end: node.attributes.end,
                      text: ` animation={{ ${property}: ${text} }}`,
                    };
              },
            };
        if (animationReason || (assigned && literal !== null))
          fields[property] = readonly(
            animationReason ?? "The layer animation controls this value",
            fields[property]!.description.value,
          );
      }
      for (
        let ancestor: ts.Node | undefined = node.parent;
        ancestor;
        ancestor = ancestor.parent
      ) {
        if (ts.isJsxElement(ancestor) && ancestor.openingElement !== node) {
          const tag = ancestor.openingElement.tagName;
          const sequence = ts.isIdentifier(tag)
            ? sequences.has(tag.text)
            : ts.isPropertyAccessExpression(tag) &&
              ts.isIdentifier(tag.expression) &&
              namespaces.has(tag.expression.text) &&
              tag.name.text === "Sequence";
          if (isLayer(tag) || sequence)
            for (const key of [
              "from",
              "durationFrames",
              ...Object.keys(geometryStyles),
            ])
              fields[key] = readonly(
                "Nested timing and layout belong to a local source scope",
                fields[key]!.description.value,
              );
        }
      }
      const parent = node.parent;
      if (ts.isJsxElement(parent)) {
        const children = parent.children.filter(
          (child) => !ts.isJsxText(child) || child.text.trim(),
        );
        const child = children.length === 1 ? children[0] : undefined;
        if (
          child &&
          ts.isJsxText(child) &&
          !/&(?:#\w+|\w+);/.test(child.text)
        ) {
          const text = jsxText(child.text);
          fields.text = {
            description: { value: text, editable: true },
            write: (next) => ({
              start: child.pos,
              end: child.end,
              text: `{${JSON.stringify(next)}}`,
            }),
          };
        } else if (
          child &&
          ts.isJsxExpression(child) &&
          typeof scalar(child.expression) === "string"
        ) {
          fields.text = {
            description: { value: scalar(child.expression), editable: true },
            write: (next) => replace(child.expression!, JSON.stringify(next)),
          };
        } else
          fields.text = readonly(
            "Text editing requires one plain text child or string literal expression",
          );
        const picture =
          child && ts.isJsxElement(child)
            ? child.openingElement
            : child && ts.isJsxSelfClosingElement(child)
              ? child
              : undefined;
        if (picture && matches(picture.tagName, images, "StillImage")) {
          const src = picture.attributes.properties.find(
            (item): item is ts.JsxAttribute =>
              ts.isJsxAttribute(item) && item.name.getText(file) === "src",
          );
          const literal = scalar(value(src));
          fields["image.src"] = shadowed(picture.tagName)
            ? readonly(
                "This image import name is shadowed by a local binding",
                literal,
              )
            : picture.attributes.properties.some(ts.isJsxSpreadAttribute) ||
                duplicates(
                  picture.attributes.properties.map((item) =>
                    ts.isJsxAttribute(item)
                      ? item.name.getText(file)
                      : undefined,
                  ),
                )
              ? readonly(
                  "Image spreads or duplicate attributes can override its source",
                  literal,
                )
              : typeof literal !== "string"
                ? readonly(expressionReason)
                : {
                    description: { value: literal, editable: true },
                    write: (next) =>
                      replace(src!.initializer!, `{${JSON.stringify(next)}}`),
                  };
        }
      } else
        fields.text = readonly(
          "Text editing requires one plain text child or string literal expression",
        );
      const reason =
        typeof id !== "string" || !id.trim()
          ? "Use a unique inline string id to enable source edits"
          : shadowed(node.tagName)
            ? "This import name is shadowed by a local binding"
            : attrs.some(ts.isJsxSpreadAttribute) ||
                duplicates(
                  attrs.map((item) =>
                    ts.isJsxAttribute(item)
                      ? item.name.getText(file)
                      : undefined,
                  ),
                )
              ? "Spread or duplicate attributes can override these values"
              : repeated(node) || reused(node)
                ? "Callback and repeated source nodes are controlled by source code"
                : undefined;
      if (reason)
        for (const key of Object.keys(fields))
          fields[key] = readonly(reason, fields[key]!.description.value);
      elements.push({
        description: {
          id: typeof id === "string" ? id : `source-line-${line}`,
          name:
            typeof name === "string"
              ? name
              : typeof id === "string"
                ? id
                : `Layer at line ${line}`,
          kind: "layer",
          line,
          fields: Object.fromEntries(
            Object.entries(fields).map(([key, field]) => [
              key,
              field.description,
            ]),
          ),
        },
        fields,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const element of elements) {
    if (
      elements.filter(
        (other) => other.description.id === element.description.id,
      ).length > 1
    ) {
      for (const [key, field] of Object.entries(element.fields))
        element.fields[key] = readonly(
          "Duplicate IDs cannot identify one source element",
          field.description.value,
        );
      element.description.fields = Object.fromEntries(
        Object.entries(element.fields).map(([key, field]) => [
          key,
          field.description,
        ]),
      );
    }
  }
  return { file, elements };
}

export function inspectCodeSource(path: string, source: string): CodeElement[] {
  return parse(path, source).elements.map((element) => element.description);
}

export function editCodeSource(
  path: string,
  source: string,
  edits: CodeEdit[],
): string {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 100)
    throw new StudioCodeError(
      400,
      "studio.code_edits",
      "Supply between 1 and 100 literal edits",
    );
  let candidate = source;
  const keys = new Set<string>();
  for (const edit of edits) {
    if (
      !edit ||
      typeof edit.id !== "string" ||
      typeof edit.field !== "string" ||
      !["string", "number", "boolean"].includes(typeof edit.value)
    )
      throw new StudioCodeError(
        400,
        "studio.code_edit",
        "Each edit needs id, field and a literal value",
      );
    const key = `${edit.id}\0${edit.field}`;
    if (keys.has(key))
      throw new StudioCodeError(
        400,
        "studio.code_edit",
        "A batch may edit each field once",
      );
    keys.add(key);
    const { elements } = parse(path, candidate);
    const targets = elements.filter((item) => item.description.id === edit.id);
    if (targets.length !== 1)
      throw new StudioCodeError(
        400,
        "studio.code_target",
        `Expected one source target for ${edit.id}`,
      );
    const field = targets[0]!.fields[edit.field];
    if (!field)
      throw new StudioCodeError(
        400,
        "studio.code_field",
        `Unsupported field ${edit.field} on ${edit.id}`,
      );
    if (!field.write || !field.description.editable)
      throw new StudioCodeError(
        400,
        "studio.code_readonly",
        `${edit.id}.${edit.field}: ${field.description.reason}`,
      );
    if (edit.field.startsWith("animation.")) {
      let track;
      try {
        if (typeof edit.value !== "string")
          throw new Error("Expected JSON track");
        const value = JSON.parse(edit.value);
        track =
          value === null
            ? null
            : validateLayerAnimationTrack(
                edit.field.slice("animation.".length),
                value,
              );
      } catch (error) {
        throw new StudioCodeError(
          400,
          "studio.code_animation",
          error instanceof Error ? error.message : "Invalid keyframes",
        );
      }
      const patch = field.write(JSON.stringify(track));
      candidate =
        candidate.slice(0, patch.start) +
        patch.text +
        candidate.slice(patch.end);
      continue;
    }
    if (
      [
        "text",
        "name",
        "src",
        "image.src",
        "style.color",
        "style.backgroundColor",
      ].includes(edit.field)
    ) {
      if (typeof edit.value !== "string")
        throw new StudioCodeError(
          400,
          "studio.code_value",
          `${edit.field} requires text`,
        );
      if (["src", "image.src"].includes(edit.field) && !edit.value.trim())
        throw new StudioCodeError(
          400,
          "studio.code_value",
          `${edit.field} requires a media path`,
        );
    } else if (edit.field === "muted") {
      if (typeof edit.value !== "boolean")
        throw new StudioCodeError(
          400,
          "studio.code_value",
          "muted requires a boolean",
        );
    } else if (
      edit.field === "style.fontSize" ||
      edit.field === "style.borderRadius"
    ) {
      if (
        (typeof edit.value !== "string" || !edit.value.trim()) &&
        (typeof edit.value !== "number" ||
          !Number.isFinite(edit.value) ||
          edit.value < 0)
      )
        throw new StudioCodeError(
          400,
          "studio.code_value",
          `${edit.field} requires a nonnegative size or CSS length`,
        );
    } else if (
      typeof edit.value !== "number" ||
      !Number.isFinite(edit.value) ||
      ([
        "from",
        "durationFrames",
        "trimBeforeFrames",
        "fadeInFrames",
        "fadeOutFrames",
      ].includes(edit.field) &&
        !Number.isSafeInteger(edit.value)) ||
      ([
        "durationFrames",
        "width",
        "height",
        "opacity",
        "gain",
        "trimBeforeFrames",
        "fadeInFrames",
        "fadeOutFrames",
      ].includes(edit.field) &&
        edit.value < 0) ||
      (edit.field === "opacity" && edit.value > 1)
    )
      throw new StudioCodeError(
        400,
        "studio.code_value",
        `Invalid ${edit.field} value`,
      );
    const patch = field.write(edit.value);
    candidate =
      candidate.slice(0, patch.start) + patch.text + candidate.slice(patch.end);
  }
  for (const element of parse(path, candidate).elements) {
    const from = element.description.fields.from?.value;
    const duration = element.description.fields.durationFrames?.value;
    if (
      typeof from === "number" &&
      typeof duration === "number" &&
      !Number.isSafeInteger(from + duration)
    ) {
      throw new StudioCodeError(
        400,
        "studio.code_value",
        `${element.description.id}: from + durationFrames must be a safe integer`,
      );
    }
  }
  return candidate;
}
