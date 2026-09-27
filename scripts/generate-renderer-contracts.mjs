#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(repoRoot, "contracts/renderer-protocol.json");
const checkOnly = process.argv.includes("--check");

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const browserProtocolVersion = contract.browserProtocolVersion;
const outputApiVersion = contract.outputApiVersion;
if (!Number.isSafeInteger(outputApiVersion) || outputApiVersion < 1)
  throw new Error("outputApiVersion must be a positive integer");
if (
  !Number.isSafeInteger(browserProtocolVersion) ||
  browserProtocolVersion < 1 ||
  browserProtocolVersion > 0xffff_ffff
) {
  throw new Error("browserProtocolVersion must be a positive u32");
}
const rendererEvents = requiredArray(
  contract.rendererEvents,
  "rendererEvents",
).map((event, index) => {
  const eventName = requiredString(event.name, `rendererEvents[${index}].name`);
  const fields = requiredArray(
    event.fields,
    `rendererEvents[${index}].fields`,
  ).map((field, fieldIndex) => ({
    name: requiredString(
      field.name,
      `rendererEvents[${index}].fields[${fieldIndex}].name`,
    ),
    type: requiredString(
      field.type,
      `rendererEvents[${index}].fields[${fieldIndex}].type`,
    ),
    required: requiredBoolean(
      field.required,
      `rendererEvents[${index}].fields[${fieldIndex}].required`,
    ),
    integer: field.integer,
    deprecated: field.deprecated,
  }));
  assertUnique(
    fields.map((field) => field.name),
    `rendererEvents[${index}].fields.name`,
  );
  return { name: eventName, fields };
});
const rendererEventNames = rendererEvents.map((event) => event.name);
const backendDiagnosticCodes = requiredArray(
  contract.backendDiagnosticCodes,
  "backendDiagnosticCodes",
).map((entry, index) =>
  requiredString(entry.code, `backendDiagnosticCodes[${index}].code`),
);

assertUnique(rendererEventNames, "rendererEvents.name");
assertUnique(backendDiagnosticCodes, "backendDiagnosticCodes.code");

const generatedFiles = new Map([
  [
    "packages/cli/src/generated/renderer-contracts.ts",
    tsContracts(rendererEvents, backendDiagnosticCodes),
  ],
  ["crates/renderer/src/generated/mod.rs", rustGeneratedMod()],
  [
    "crates/renderer/src/generated/contracts.rs",
    rustContracts(rendererEvents, backendDiagnosticCodes),
  ],
  ["crates/protocol/src/generated.rs", rustWireTypes(rendererEvents)],
  [
    "packages/core/src/generated/browser-contracts.ts",
    `${header("TypeScript")}${tsWireTypes(["AudioEnvelopePoint", "AudioClip", "AudioPlan", "CompositionManifest", "RenderSession", "RenderContext"])}`,
  ],
  ["scripts/generated/__init__.py", pythonGeneratedPackage()],
  [
    "scripts/generated/renderer_contracts.py",
    pythonContracts(rendererEvents, backendDiagnosticCodes),
  ],
]);

let stale = false;
for (const [path, source] of generatedFiles) {
  const content = path.endsWith(".ts")
    ? await format(source, { parser: "typescript" })
    : source;
  const absolutePath = join(repoRoot, path);
  if (checkOnly) {
    const current = existsSync(absolutePath)
      ? readFileSync(absolutePath, "utf8")
      : undefined;
    if (current !== content) {
      stale = true;
      console.error(`${path} is stale; run pnpm contracts:generate`);
    }
    continue;
  }

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  console.log(`generated ${relative(repoRoot, absolutePath)}`);
}

if (stale) {
  process.exitCode = 1;
}

function tsContracts(events, diagnosticCodes) {
  const eventNames = events.map((event) => event.name);
  return `${header("TypeScript")}
export const RENDERER_EVENT_NAMES = ${tsConstArray(eventNames)} as const;
export type RendererEventName = (typeof RENDERER_EVENT_NAMES)[number];

export const RENDERER_EVENT_FIELD_CONTRACTS = ${tsObject(eventsToFieldContracts(events))} as const;

export const RENDERER_BACKEND_DIAGNOSTIC_CODES = ${tsConstArray(diagnosticCodes)} as const;
export type RendererBackendDiagnosticCode =
  (typeof RENDERER_BACKEND_DIAGNOSTIC_CODES)[number];

${tsEventTypes(events)}
${tsWireTypes(Object.keys(contract.wireRecords))}
`;
}

function pascalCase(value) {
  return value.replace(/(^|_)([a-z])/g, (_, _separator, letter) =>
    letter.toUpperCase(),
  );
}

function tsType(field) {
  const value = field.type
    .split("|")
    .map((type) =>
      type === "integer" ? "number" : type === "json" ? "unknown" : type,
    )
    .join(" | ");
  return field.nullable && !field.type.includes("null")
    ? `${value} | null`
    : value;
}

function tsEventTypes(events) {
  return `${events
    .map(
      (event) => `export interface ${pascalCase(event.name)}Event {
  event: ${JSON.stringify(event.name)};
${event.fields.map((field) => `${field.deprecated ? `  /** @deprecated ${field.deprecated} */\n` : ""}  ${field.name}${field.required ? "" : "?"}: ${tsType(field)};`).join("\n")}
}`,
    )
    .join("\n\n")}

export type KnownRendererEvent = ${events.map((event) => `${pascalCase(event.name)}Event`).join(" | ")};
export interface UnknownRendererEvent { event: string; [key: string]: unknown; }
export type RendererEvent = KnownRendererEvent | UnknownRendererEvent;

/** Unknown event names and extra fields remain forward compatible. */
export function validateRendererEvent(value: unknown): asserts value is RendererEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("renderer event must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.event !== "string") throw new Error("renderer event must have an event string");
  switch (record.event) {
${events.map((event) => `    case ${JSON.stringify(event.name)}:\n${event.fields.map((field) => tsFieldValidation(field, event.name, "      ")).join("\n")}\n      break;`).join("\n")}
  }
}
`;
}

function tsFieldValidation(field, owner, indent) {
  // Arbitrary payloads have already crossed JSON parsing/serialization at the transport seam.
  if (field.type === "json") return "";
  const value = `record.${field.name}`;
  const allowed = [];
  if (!field.required) allowed.push(`${value} === undefined`);
  if (field.type.includes("null") || field.nullable)
    allowed.push(`${value} === null`);
  const type = field.type.split("|")[0];
  if (type === "integer") {
    const maximum = {
      u32: "0xffff_ffff",
      nonzero_u32: "0xffff_ffff",
      // JSON.parse already uses IEEE-754 numbers; preserve that existing representation
      // for native counters while making the u64-to-number conversion explicit.
      u64: "Number(0xffff_ffff_ffff_ffffn)",
      usize: "Number(0xffff_ffff_ffff_ffffn)",
      safe_i64: "Number.MAX_SAFE_INTEGER",
      safe_u64: "Number.MAX_SAFE_INTEGER",
    }[field.integer];
    if (!maximum)
      throw new Error(`integer encoding missing for ${owner}.${field.name}`);
    const minimum =
      field.minimum ??
      (field.integer === "safe_i64"
        ? "Number.MIN_SAFE_INTEGER"
        : field.integer === "nonzero_u32"
          ? 1
          : 0);
    allowed.push(
      `(typeof ${value} === "number" && Number.${field.integer.startsWith("safe_") ? "isSafeInteger" : "isInteger"}(${value}) && ${value} >= ${minimum} && ${value} <= ${maximum})`,
    );
  } else if (type === "number") {
    allowed.push(
      `(typeof ${value} === "number" && Number.isFinite(${value})${field.minimum === undefined ? "" : ` && ${value} >= ${field.minimum}`})`,
    );
  } else if (type.endsWith("[]") && contract.wireRecords?.[type.slice(0, -2)]) {
    const guard = allowed.length ? `if (!(${allowed.join(" || ")})) ` : "";
    return `${indent}${guard}{ if (!Array.isArray(${value})) throw new Error(${JSON.stringify(`${owner}.${field.name} must be an array`)}); for (const item of ${value}) validate${type.slice(0, -2)}(item); }`;
  } else if (contract.wireEnums?.[type]) {
    allowed.push(
      ...contract.wireEnums[type].values.map(
        (entry) => `${value} === ${JSON.stringify(entry)}`,
      ),
    );
  } else if (contract.wireUnions?.[type]) {
    const union = contract.wireUnions[type];
    allowed.push(
      `${value} === ${JSON.stringify(union.literal)}`,
      `(typeof ${value} === "number" && Number.isInteger(${value}) && ${value} > 0 && ${value} <= 0xffff_ffff)`,
    );
  } else if (contract.wireRecords?.[type]) {
    const guard = allowed.length ? `if (!(${allowed.join(" || ")})) ` : "";
    return `${indent}${guard}validate${type}(${value});`;
  } else {
    allowed.push(`typeof ${value} === ${JSON.stringify(type)}`);
  }
  return `${indent}if (!(${allowed.join(" || ")})) throw new Error(${JSON.stringify(`${owner}.${field.name} must match ${field.type}`)});`;
}

function tsWireTypes(recordNames) {
  return `export const BROWSER_PROTOCOL_VERSION = ${browserProtocolVersion} as const;\nexport const OUTPUT_API_VERSION = ${outputApiVersion} as const;\n\n${Object.entries(
    contract.wireEnums,
  )
    .map(
      ([name, value]) =>
        `export type ${name} = ${value.values.map((entry) => JSON.stringify(entry)).join(" | ")};`,
    )
    .join("\n")}
${Object.entries(contract.wireUnions)
  .map(
    ([name, value]) =>
      `export type ${name} = ${JSON.stringify(value.literal)} | number;`,
  )
  .join("\n")}

${recordNames
  .map((name) => {
    const record = contract.wireRecords[name];
    return `export interface ${name} {
${record.fields.map((field) => `  ${field.name}${field.required ? "" : "?"}: ${tsType(field)};`).join("\n")}
}

export function validate${name}(value: unknown): asserts value is ${name} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("${name} must be an object");
  const record = value as Record<string, unknown>;
${record.fields.map((field) => tsFieldValidation(field, name, "  ")).join("\n")}
${record.validate ? tsRenderJobModes() : ""}}
`;
  })
  .join("\n")}`;
}

function tsRenderJobModes() {
  return `  switch (record.mode) {\n${Object.entries(contract.renderJobModes)
    .map(
      ([mode, rule]) => `    case ${JSON.stringify(mode)}:
${rule.forbidden?.length ? `      if (${rule.forbidden.map((field) => `record.${field} != null`).join(" || ")}) throw new Error(${JSON.stringify(rule.forbiddenError)});\n` : ""}${(rule.required ?? []).map((field) => `      if (record.${field} == null) throw new Error(${JSON.stringify(`${mode} job requires ${field}`)});`).join("\n")}
      break;`,
    )
    .join("\n")}\n  }\n`;
}

function snakeCase(value) {
  return value
    .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    .replace(/^_/, "");
}

function rustFieldType(field) {
  const type =
    {
      string: "String",
      boolean: "bool",
      json: "serde_json::Value",
      integer:
        field.integer === "nonzero_u32"
          ? "std::num::NonZeroU32"
          : field.integer?.replace(/^safe_/, ""),
      number: "f64",
    }[field.type] ??
    (field.type.endsWith("[]")
      ? `Vec<${field.type.slice(0, -2)}>`
      : field.type);
  return !field.required && field.default === undefined
    ? `Option<${type}>`
    : type;
}

function rustRecord(name, record, raw = false) {
  return `#[derive(Debug, Clone, ${raw ? "Deserialize" : record.validate ? "Serialize" : "Serialize, Deserialize"}, PartialEq${record.eq === false ? "" : ", Eq"})]
${raw ? "struct Raw" : "pub struct "}${name} {
${record.fields
  .map((field) => {
    const attrs = [];
    const rustName = snakeCase(field.name);
    if (field.name !== rustName)
      attrs.push(`rename = ${JSON.stringify(field.name)}`);
    if (field.default !== undefined)
      attrs.push(`default = "default_${snakeCase(name)}_${rustName}"`);
    else if (field.error) attrs.push("default");
    if (field.omitNone) attrs.push('skip_serializing_if = "Option::is_none"');
    if (field.error) attrs.push(`deserialize_with = "deserialize_${rustName}"`);
    return `${attrs.length ? `    #[serde(${attrs.join(", ")})]\n` : ""}    pub ${rustName}: ${rustFieldType(field)},`;
  })
  .join("\n")}
}
`;
}

function rustWireTypes(events) {
  return rustfmt(`${rustEventTypes(events)}
pub const BROWSER_PROTOCOL_VERSION: u32 = ${browserProtocolVersion};
pub const OUTPUT_API_VERSION: u32 = ${outputApiVersion};
${Object.entries(contract.wireEnums)
  .map(
    ([
      name,
      value,
    ]) => `#[derive(Debug, Clone, Copy, ${value.default ? "Default, " : ""}Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ${name} {
${value.values.map((entry) => `${value.default === entry ? "    #[default]\n" : ""}    ${pascalCase(entry)},`).join("\n")}
}
`,
  )
  .join("\n")}
${Object.entries(contract.wireUnions)
  .map(([name, union]) => rustUnion(name, union))
  .join("\n")}
${Object.entries(contract.wireRecords)
  .map(
    ([name, record]) => `${rustRecord(name, record)}
${
  record.validate
    ? `${rustRecord(name, record, true)}
impl<'de> Deserialize<'de> for ${name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Raw${name}::deserialize(deserializer)?;
        let job = Self {
${record.fields.map((field) => `            ${snakeCase(field.name)}: raw.${snakeCase(field.name)},`).join("\n")}
        };
        validate_render_job_mode(&job).map_err(serde::de::Error::custom)?;
        Ok(job)
    }
}
`
    : ""
}
${record.fields
  .filter((field) => field.error)
  .map(
    (
      field,
    ) => `fn deserialize_${snakeCase(field.name)}<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<${rustFieldType(field)}, D::Error> {
    <${rustFieldType(field)}>::deserialize(deserializer).map_err(|_| serde::de::Error::custom(${JSON.stringify(field.error)}))
}
`,
  )
  .join("\n")}
${record.fields
  .filter((field) => field.default !== undefined)
  .map(
    (
      field,
    ) => `fn default_${snakeCase(name)}_${snakeCase(field.name)}() -> ${rustFieldType(field)} {
    ${contract.wireEnums[field.type] ? `${field.type}::${pascalCase(field.default)}` : JSON.stringify(field.default)}
}
`,
  )
  .join("\n")}`,
  )
  .join("\n")}
pub(crate) fn validate_render_job_mode(job: &RenderJob) -> Result<(), String> {
    match job.mode {
${Object.entries(contract.renderJobModes)
  .map(
    ([mode, rule]) => `        RenderMode::${pascalCase(mode)} => {
${rule.forbidden?.length ? `            if ${rule.forbidden.map((field) => `job.${field}.is_some()`).join(" || ")} { return Err(${JSON.stringify(rule.forbiddenError)}.to_owned()); }\n` : ""}${(rule.required ?? []).map((field) => `            if job.${field}.is_none() { return Err(${JSON.stringify(`${mode} job requires ${field}`)}.to_owned()); }`).join("\n")}
        }`,
  )
  .join("\n")}
    }
    Ok(())
}
`);
}

function rustUnion(name, union) {
  if (union.integer !== "nonzero_u32")
    throw new Error(`unsupported integer union ${name}`);
  return `#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ${name} { ${union.rustLiteralVariant}, ${union.rustIntegerVariant}(std::num::NonZeroU32) }
impl Serialize for ${name} {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::${union.rustLiteralVariant} => serializer.serialize_str(${JSON.stringify(union.literal)}),
            Self::${union.rustIntegerVariant}(workers) => serializer.serialize_u32(workers.get()),
        }
    }
}
impl<'de> Deserialize<'de> for ${name} {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct UnionVisitor;
        impl<'de> serde::de::Visitor<'de> for UnionVisitor {
            type Value = ${name};
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result { formatter.write_str(${JSON.stringify(union.error)}) }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value == ${JSON.stringify(union.literal)} { Ok(${name}::${union.rustLiteralVariant}) } else { Err(E::custom(${JSON.stringify(union.error)})) }
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                u32::try_from(value).ok().and_then(std::num::NonZeroU32::new).map(${name}::${union.rustIntegerVariant}).ok_or_else(|| E::custom(${JSON.stringify(union.error)}))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                if value <= 0 { Err(E::custom(${JSON.stringify(union.error)})) } else { self.visit_u64(value as u64) }
            }
        }
        deserializer.deserialize_any(UnionVisitor)
    }
}
`;
}

function rustEventTypes(events) {
  return rustfmt(`${header("Rust")}use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RendererEvent {
${events
  .map(
    (event) =>
      `    ${pascalCase(event.name)} {\n${event.fields
        .map((field) => {
          const rustType = {
            string: "String",
            integer: field.integer,
            boolean: "bool",
          }[field.type.split("|")[0]];
          return `        ${field.name}: ${field.required ? rustType : `Option<${rustType}>`},`;
        })
        .join("\n")}\n    },`,
  )
  .join("\n")}
}
`);
}

function rustGeneratedMod() {
  return `${header("Rust")}pub mod contracts;
`;
}

function rustContracts(events, diagnosticCodes) {
  const eventNames = events.map((event) => event.name);
  return rustfmt(`${header("Rust")}#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub struct RendererEventFieldContract {
    pub name: &'static str,
    pub value_type: &'static str,
    pub required: bool,
}

#[allow(dead_code)]
pub const RENDERER_EVENT_NAMES: &[&str] = &${rustArray(eventNames)};

#[allow(dead_code)]
pub const RENDERER_EVENT_FIELD_CONTRACTS: &[(&str, &[RendererEventFieldContract])] = &${rustEventFieldContracts(events)};

#[allow(dead_code)]
pub const RENDERER_BACKEND_DIAGNOSTIC_CODES: &[&str] = &${rustArray(diagnosticCodes)};
`);
}

function pythonGeneratedPackage() {
  return header("Python").trimEnd() + "\n";
}

function pythonContracts(events, diagnosticCodes) {
  const eventNames = events.map((event) => event.name);
  return `${header("Python")}BROWSER_PROTOCOL_VERSION = ${browserProtocolVersion}\n\nRENDERER_EVENT_NAMES = ${pythonTuple(eventNames)}

RENDERER_EVENT_FIELD_CONTRACTS = ${pythonObject(eventsToFieldContracts(events))}

BACKEND_DIAGNOSTIC_CODES = frozenset(${pythonTuple(diagnosticCodes)})
`;
}

function header(language) {
  const comment = language === "Python" ? "#" : "//";
  return `${comment} @generated by scripts/generate-renderer-contracts.mjs from contracts/renderer-protocol.json.\n${comment} Do not edit by hand.\n\n`;
}

function rustfmt(source) {
  const result = spawnSync(
    "rustfmt",
    ["--edition", "2021", "--emit", "stdout"],
    {
      input: source,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `rustfmt failed for generated Rust contracts: ${result.stderr}`,
    );
  }
  return result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`;
}

function tsConstArray(values) {
  return `[\n${values.map((value) => `  ${JSON.stringify(value)},`).join("\n")}\n]`;
}

function rustArray(values) {
  return `[\n${values.map((value) => `    ${JSON.stringify(value)},`).join("\n")}\n]`;
}

function eventsToFieldContracts(events) {
  return Object.fromEntries(
    events.map((event) => [
      event.name,
      event.fields.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
      })),
    ]),
  );
}

function tsObject(value) {
  return JSON.stringify(value, null, 2).replace(/"([^"\\]+)":/g, "$1:");
}

function pythonObject(value) {
  return pythonLiteral(value, 0);
}

function pythonLiteral(value, indent) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value === null) {
    return "None";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const nextIndent = indent + 4;
    const body = value
      .map(
        (item) =>
          `${" ".repeat(nextIndent)}${pythonLiteral(item, nextIndent)},`,
      )
      .join("\n");
    return `[\n${body}\n${" ".repeat(indent)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    const nextIndent = indent + 4;
    const body = entries
      .map(
        ([key, item]) =>
          `${" ".repeat(nextIndent)}${JSON.stringify(key)}: ${pythonLiteral(item, nextIndent)},`,
      )
      .join("\n");
    return `{\n${body}\n${" ".repeat(indent)}}`;
  }
  throw new Error(`unsupported Python literal value: ${value}`);
}

function rustEventFieldContracts(events) {
  const body = events
    .map((event) => {
      const fields = event.fields
        .map(
          (field) =>
            `        RendererEventFieldContract { name: ${JSON.stringify(field.name)}, value_type: ${JSON.stringify(field.type)}, required: ${field.required} },`,
        )
        .join("\n");
      return `    (\n        ${JSON.stringify(event.name)},\n        &[\n${fields}\n        ],\n    ),`;
    })
    .join("\n");
  return `[\n${body}\n]`;
}

function pythonTuple(values) {
  const body = values
    .map((value) => `    ${JSON.stringify(value)},`)
    .join("\n");
  return `(\n${body}\n)`;
}

function requiredArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function assertUnique(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${name} contains duplicate value ${value}`);
    }
    seen.add(value);
  }
}
