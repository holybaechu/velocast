import { withMediaRuntimeContext } from "./media-runtime.js";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type { Config } from "@velocast/core";
import { BROWSER_PROTOCOL_VERSION } from "./generated/renderer-contracts.js";
import {
  launchCdpBrowser,
  cleanupBrowserResources,
  type CdpBrowser,
} from "./browser-cdp.js";
import { createInputSnapshot } from "./input-snapshot.js";
import {
  getInvocationCwd,
  resolveCliInputPropsPath,
  resolveCliOutputPath,
  type InvocationPathOptions,
} from "./paths.js";
import { resolveCompositionRenderSource } from "./render-source.js";
import {
  createVideoFrameHttp,
  type VideoFrameHttp,
} from "./video-frame-http.js";

export interface AuditSelectorAssertion {
  selector: string;
  visible?: boolean;
  insideComposition?: boolean;
  noClipping?: boolean;
  minContrast?: number;
  motion?: {
    fromFrame: number;
    toFrame: number;
    minPixels?: number;
    maxPixels?: number;
  };
}

export interface AuditAssertions {
  selectors: AuditSelectorAssertion[];
}

export interface AgentAuditOptions extends InvocationPathOptions {
  frames?: string | number;
  assertions?: string;
  inputPropsFile?: string;
  snapshots?: string;
  browser?: string;
  strict?: boolean;
  json?: boolean;
  write?: (text: string) => void;
}

export interface AuditBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AuditSelectorResult {
  selector: string;
  found: boolean;
  visible: boolean;
  box: AuditBox | null;
  insideComposition: boolean | null;
  clippedBy: string[];
  contrast: number | null;
}

export interface AgentAuditIssue {
  severity: "error" | "warning";
  code: string;
  frame?: number;
  selector?: string;
  message: string;
}

export interface AgentAuditReport {
  schemaVersion: 1;
  status: "passed" | "failed";
  source: { sessionId: string; sourceVersion: string };
  browser: { executable: string };
  composition: {
    id: string;
    width: number;
    height: number;
    fps: number;
    durationFrames: number;
    target: string;
  };
  sampledFrames: Array<{
    frame: number;
    timeSeconds: number;
    viewport: {
      width: number;
      height: number;
      scrollWidth: number;
      scrollHeight: number;
      rootBox: AuditBox | null;
    };
    automaticTextAudit: {
      totalCandidates: number;
      examined: number;
      truncated: boolean;
      unmeasurableContrast: number;
      findings: Array<{
        selector: string;
        source: string | null;
        box: AuditBox;
        contrast: number | null;
        codes: string[];
        clippedBy: string[];
      }>;
    };
    selectors: AuditSelectorResult[];
    runtimeErrors: string[];
    snapshot: string | null;
  }>;
  motion: Array<{
    selector: string;
    fromFrame: number;
    toFrame: number;
    distancePixels: number | null;
  }>;
  issues: AgentAuditIssue[];
  limits: string[];
}

interface CompositionManifest {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  target: string;
}

let browserRuntimeDataUrl: Promise<string> | undefined;
async function loadBrowserRuntimeDataUrl(): Promise<string> {
  return (browserRuntimeDataUrl ??= (async () => {
    const root = dirname(
      createRequire(import.meta.url).resolve("@velocast/preview"),
    );
    const manifest = JSON.parse(
      await readFile(join(root, "platform/manifest.json"), "utf8"),
    ) as {
      browserProtocolVersion?: unknown;
      sha256?: Record<string, unknown>;
    };
    const bytes = await readFile(join(root, "platform/browser-runtime.js"));
    if (
      manifest.browserProtocolVersion !== BROWSER_PROTOCOL_VERSION ||
      manifest.sha256?.["browser-runtime.js"] !==
        createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error(
        "audit.runtime_incompatible: installed preview runtime does not match the browser protocol",
      );
    return `data:text/javascript;base64,${bytes.toString("base64")}`;
  })());
}

function parseFrames(
  value: string | number | undefined,
  duration: number,
): number[] {
  const requested =
    value === undefined
      ? [0, Math.floor((duration - 1) / 2), duration - 1]
      : String(value)
          .split(",")
          .map((item) => Number(item.trim()));
  if (
    requested.some(
      (frame) => !Number.isSafeInteger(frame) || frame < 0 || frame >= duration,
    )
  )
    throw new Error(
      `audit.invalid_frames: use integer frames in [0, ${duration})`,
    );
  return [...new Set(requested)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateAuditAssertions(value: unknown): AuditAssertions {
  if (!isRecord(value) || !Array.isArray(value.selectors))
    throw new Error("audit.invalid_assertions: expected { selectors: [...] }");
  const selectors = value.selectors.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.selector !== "string" ||
      !candidate.selector.trim()
    )
      throw new Error(
        `audit.invalid_assertions: selectors[${index}].selector is required`,
      );
    for (const key of ["visible", "insideComposition", "noClipping"] as const)
      if (candidate[key] !== undefined && typeof candidate[key] !== "boolean")
        throw new Error(
          `audit.invalid_assertions: selectors[${index}].${key} must be boolean`,
        );
    if (
      candidate.minContrast !== undefined &&
      (typeof candidate.minContrast !== "number" ||
        candidate.minContrast < 1 ||
        candidate.minContrast > 21)
    )
      throw new Error(
        `audit.invalid_assertions: selectors[${index}].minContrast must be 1..21`,
      );
    let motion: AuditSelectorAssertion["motion"];
    if (candidate.motion !== undefined) {
      if (!isRecord(candidate.motion))
        throw new Error(
          `audit.invalid_assertions: selectors[${index}].motion must be an object`,
        );
      const fromFrame = candidate.motion.fromFrame;
      const toFrame = candidate.motion.toFrame;
      if (!Number.isSafeInteger(fromFrame) || !Number.isSafeInteger(toFrame))
        throw new Error(
          `audit.invalid_assertions: motion frames must be integers`,
        );
      const minPixels = candidate.motion.minPixels;
      const maxPixels = candidate.motion.maxPixels;
      for (const [key, item] of [
        ["minPixels", minPixels],
        ["maxPixels", maxPixels],
      ] as const)
        if (
          item !== undefined &&
          (typeof item !== "number" || !Number.isFinite(item) || item < 0)
        )
          throw new Error(
            `audit.invalid_assertions: ${key} must be a non-negative number`,
          );
      motion = {
        fromFrame: fromFrame as number,
        toFrame: toFrame as number,
        ...(minPixels === undefined ? {} : { minPixels: minPixels as number }),
        ...(maxPixels === undefined ? {} : { maxPixels: maxPixels as number }),
      };
    }
    return {
      selector: candidate.selector.trim(),
      ...(candidate.visible === undefined
        ? {}
        : { visible: candidate.visible as boolean }),
      ...(candidate.insideComposition === undefined
        ? {}
        : { insideComposition: candidate.insideComposition as boolean }),
      ...(candidate.noClipping === undefined
        ? {}
        : { noClipping: candidate.noClipping as boolean }),
      ...(candidate.minContrast === undefined
        ? {}
        : { minContrast: candidate.minContrast as number }),
      ...(motion ? { motion } : {}),
    };
  });
  return { selectors };
}

async function loadAssertions(
  path: string | undefined,
  options: InvocationPathOptions,
): Promise<AuditAssertions> {
  if (!path) return { selectors: [] };
  const resolved = resolveCliOutputPath(path, options);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new Error(`audit.invalid_assertions: could not read ${path}`, {
      cause: error,
    });
  }
  return validateAuditAssertions(value);
}

async function waitForProtocol(browser: CdpBrowser): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      await browser.evaluate<boolean>(
        "Boolean(window.__velocast?.beginSession && window.__velocast?.getSession && window.__velocast?.getCompositions && window.__velocast?.seekFrame)",
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    "audit.protocol_missing: window.__velocast was not registered",
  );
}

const FRAME_INSPECTION = String.raw`((selectors, target) => {
  const round = value => Math.round(value * 1000) / 1000;
  const box = element => { const r = element.getBoundingClientRect(); return {x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height)}; };
  const contains = (outer, inner) => inner.left >= outer.left - .5 && inner.top >= outer.top - .5 && inner.right <= outer.right + .5 && inner.bottom <= outer.bottom + .5;
  const label = element => element.id ? '#' + CSS.escape(element.id) : element.tagName.toLowerCase() + (element.classList.length ? '.' + [...element.classList].map(CSS.escape).join('.') : '');
  const rgb = value => { const match = /^rgba?\((\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)/.exec(value); return match ? match.slice(1).map(Number) : null; };
  const luminance = color => { const parts = color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * parts[0] + .7152 * parts[1] + .0722 * parts[2]; };
  const root = document.querySelector(target);
  const rootRect = root?.getBoundingClientRect();
  const results = selectors.map(selector => {
    const element = document.querySelector(selector);
    if (!element) return {selector,found:false,visible:false,box:null,insideComposition:null,clippedBy:[],contrast:null};
    const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    const clippedBy = []; let ancestor = element.parentElement;
    while (ancestor) { const a = getComputedStyle(ancestor); if (/(hidden|clip|scroll|auto)/.test(a.overflow + a.overflowX + a.overflowY) && !contains(ancestor.getBoundingClientRect(), rect)) clippedBy.push(label(ancestor)); ancestor = ancestor.parentElement; }
    let background = element; let backgroundStyle = getComputedStyle(background); let backgroundColor = backgroundStyle.backgroundColor; let complexBackground = backgroundStyle.backgroundImage !== 'none' || Number(backgroundStyle.opacity) < 1;
    while (background.parentElement && (backgroundColor === 'rgba(0, 0, 0, 0)' || backgroundColor === 'transparent')) { background = background.parentElement; backgroundStyle = getComputedStyle(background); backgroundColor = backgroundStyle.backgroundColor; complexBackground ||= backgroundStyle.backgroundImage !== 'none' || Number(backgroundStyle.opacity) < 1; }
    const foreground = rgb(style.color); const bg = rgb(backgroundColor); let contrast = null;
    if (foreground && bg && !complexBackground) { const l1 = luminance(foreground), l2 = luminance(bg); contrast = round((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)); }
    return {selector,found:true,visible,box:box(element),insideComposition:rootRect ? contains(rootRect, rect) : null,clippedBy,contrast};
  });
  const stableSelector = element => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = []; let current = element;
    while (current && current !== root && parts.length < 6) { const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.tagName === current.tagName) : []; const suffix = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''; parts.unshift(current.tagName.toLowerCase() + suffix); current = current.parentElement; }
    return (target + ' > ' + parts.join(' > ')).trim();
  };
  const candidates = root ? [...root.querySelectorAll('*')].filter(element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) : [];
  let unmeasurableContrast = 0;
  const findings = [];
  for (const element of candidates.slice(0, 200)) {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    if (!visible) continue;
    const clippedBy = []; let ancestor = element.parentElement;
    while (ancestor) { const a = getComputedStyle(ancestor); if (/(hidden|clip|scroll|auto)/.test(a.overflow + a.overflowX + a.overflowY) && !contains(ancestor.getBoundingClientRect(), rect)) clippedBy.push(label(ancestor)); ancestor = ancestor.parentElement; }
    let background = element, backgroundStyle = getComputedStyle(background), backgroundColor = backgroundStyle.backgroundColor, complexBackground = backgroundStyle.backgroundImage !== 'none' || Number(backgroundStyle.opacity) < 1;
    while (background.parentElement && (backgroundColor === 'rgba(0, 0, 0, 0)' || backgroundColor === 'transparent')) { background = background.parentElement; backgroundStyle = getComputedStyle(background); backgroundColor = backgroundStyle.backgroundColor; complexBackground ||= backgroundStyle.backgroundImage !== 'none' || Number(backgroundStyle.opacity) < 1; }
    const foreground = rgb(style.color), bg = rgb(backgroundColor); let contrast = null;
    if (foreground && bg && !complexBackground) { const l1 = luminance(foreground), l2 = luminance(bg); contrast = round((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)); } else unmeasurableContrast++;
    const largeText = parseFloat(style.fontSize) >= (Number(style.fontWeight) >= 700 ? 18.66 : 24);
    const codes = [];
    if (rootRect && !contains(rootRect, rect)) codes.push('layout.outside_composition');
    if (clippedBy.length) codes.push('layout.clipped');
    if (contrast !== null && contrast < (largeText ? 3 : 4.5)) codes.push('contrast.below_wcag_aa');
    if (codes.length) findings.push({selector:stableSelector(element),source:element.closest('[data-velocast-source]')?.getAttribute('data-velocast-source') ?? null,box:box(element),contrast,codes,clippedBy});
  }
  return {selectors:results,automaticTextAudit:{totalCandidates:candidates.length,examined:Math.min(200,candidates.length),truncated:candidates.length>200,unmeasurableContrast,findings},viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,rootBox:root ? box(root) : null}};
})`;

async function inspectFrame(
  browser: CdpBrowser,
  composition: CompositionManifest,
  frame: number,
  selectors: string[],
  session: { sessionId: string; sourceVersion: string },
  inputProps: unknown,
): Promise<{
  selectors: AuditSelectorResult[];
  runtimeErrors: string[];
  viewport: AgentAuditReport["sampledFrames"][number]["viewport"];
  automaticTextAudit: AgentAuditReport["sampledFrames"][number]["automaticTextAudit"];
}> {
  const expression = `(async()=>{await window.__velocastAuditRuntime.completeFrame(()=>window.__velocast.seekFrame(${JSON.stringify(composition.id)},${frame},{renderSession:${JSON.stringify(session)},inputProps:${JSON.stringify(inputProps)}}));const runtimeErrors=window.__velocastAuditErrors.splice(0);if(window.__velocastAuditErrorsDropped){runtimeErrors.push('audit.runtime_errors_truncated: '+window.__velocastAuditErrorsDropped+' additional errors');window.__velocastAuditErrorsDropped=0;}return {...${FRAME_INSPECTION}(${JSON.stringify(selectors)},${JSON.stringify(composition.target)}),runtimeErrors}})()`;
  return browser.evaluate(expression);
}

export async function auditComposition(
  config: Config,
  compositionId: string,
  options: AgentAuditOptions = {},
): Promise<AgentAuditReport> {
  const env = options.env
    ? { ...process.env, ...options.env }
    : { ...process.env };
  return withMediaRuntimeContext(
    {
      configuredBinary: config.renderer?.binary,
      cwd: getInvocationCwd(options),
      env,
    },
    () => auditCompositionInContext(config, compositionId, options),
  );
}

async function auditCompositionInContext(
  config: Config,
  compositionId: string,
  options: AgentAuditOptions,
): Promise<AgentAuditReport> {
  const source = resolveCompositionRenderSource(config, options);
  if (!source.snapshotRoot || source.kind !== "entry")
    throw new Error(
      "audit.requires_snapshot: check requires a built local entry and renderer.snapshotRoot",
    );
  const propsPath = resolveCliInputPropsPath(options.inputPropsFile, options);
  let media: VideoFrameHttp | undefined;
  const snapshot = await createInputSnapshot({
    root: source.snapshotRoot,
    entryPath: fileURLToPath(source.url),
    ...(propsPath ? { inputPropsPath: propsPath } : {}),
    handleMediaRequest: async (request, response, identity) => {
      media ??= createVideoFrameHttp({
        directory: tmpdir(),
        env: options.env ? { ...process.env, ...options.env } : process.env,
      });
      return media.handle(request, response, identity);
    },
  });
  const inputProps = snapshot.inputPropsPath
    ? JSON.parse(
        (await readFile(snapshot.inputPropsPath, "utf8")).replace(
          /^\uFEFF/,
          "",
        ),
      )
    : undefined;
  let browser: CdpBrowser | undefined;
  let primaryFailure: { error: unknown } | undefined;
  try {
    browser = await launchCdpBrowser("about:blank", {
      executable: options.browser,
    });
    await browser.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__velocastAuditErrors=[];window.__velocastAuditErrorsDropped=0;const recordVelocastAuditError=value=>window.__velocastAuditErrors.length<100?window.__velocastAuditErrors.push(String(value)):window.__velocastAuditErrorsDropped++;addEventListener('error',event=>recordVelocastAuditError(event.error?.stack||event.message));addEventListener('unhandledrejection',event=>recordVelocastAuditError(event.reason?.stack||event.reason));`,
    });
    await browser.call("Page.navigate", { url: snapshot.url });
    await waitForProtocol(browser);
    const runtimeUrl = await loadBrowserRuntimeDataUrl();
    await browser.evaluate(
      `(async()=>{const runtime=(await import(${JSON.stringify(runtimeUrl)})).browserRuntime;runtime.assertProtocol(${BROWSER_PROTOCOL_VERSION});const session=${JSON.stringify(snapshot.session)};await runtime.bindSession(session);${inputProps === undefined ? "" : `await runtime.setInputProps(${JSON.stringify(inputProps)});`}await runtime.waitForReady();window.__velocastAuditRuntime=runtime;})()`,
    );
    const compositions = await browser.evaluate<CompositionManifest[]>(
      "window.__velocast.getCompositions()",
    );
    const composition = compositions.find((item) => item.id === compositionId);
    if (!composition)
      throw new Error(`audit.composition_not_found: ${compositionId}`);
    await browser.call("Emulation.setDeviceMetricsOverride", {
      width: composition.width,
      height: composition.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.evaluate(
      `window.__velocastAuditRuntime.renderEnvironment(${composition.width},${composition.height});window.__velocastAuditRuntime.selectTarget(${JSON.stringify(composition.target)});`,
    );
    const assertions = await loadAssertions(options.assertions, options);
    const frames = parseFrames(options.frames, composition.durationFrames);
    for (const assertion of assertions.selectors) {
      if (assertion.motion) {
        for (const frame of [
          assertion.motion.fromFrame,
          assertion.motion.toFrame,
        ]) {
          if (frame < 0 || frame >= composition.durationFrames)
            throw new Error(
              `audit.invalid_assertions: motion frame ${frame} outside composition`,
            );
          frames.push(frame);
        }
      }
    }
    const sampledFrames: AgentAuditReport["sampledFrames"] = [];
    const selectors = assertions.selectors.map((item) => item.selector);
    const snapshotDirectory = options.snapshots
      ? resolveCliOutputPath(options.snapshots, options)
      : undefined;
    if (snapshotDirectory) await mkdir(snapshotDirectory, { recursive: true });
    for (const frame of [...new Set(frames)].sort(
      (left, right) => left - right,
    )) {
      const inspected = await inspectFrame(
        browser,
        composition,
        frame,
        selectors,
        snapshot.session,
        inputProps,
      );
      let snapshotPath: string | null = null;
      if (snapshotDirectory) {
        const safeCompositionId = composition.id.replace(
          /[^A-Za-z0-9._-]+/g,
          "_",
        );
        snapshotPath = join(
          snapshotDirectory,
          `${safeCompositionId}-frame-${frame}.png`,
        );
        const capture = await browser.call<{ data: string }>(
          "Page.captureScreenshot",
          {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          },
        );
        await writeFile(snapshotPath, Buffer.from(capture.data, "base64"));
      }
      sampledFrames.push({
        frame,
        timeSeconds: frame / composition.fps,
        viewport: inspected.viewport,
        automaticTextAudit: inspected.automaticTextAudit,
        selectors: inspected.selectors,
        runtimeErrors: inspected.runtimeErrors,
        snapshot: snapshotPath,
      });
    }
    const issues: AgentAuditIssue[] = [];
    for (const sample of sampledFrames) {
      for (const finding of sample.automaticTextAudit.findings)
        for (const code of finding.codes)
          issues.push({
            severity: options.strict ? "error" : "warning",
            code: `automatic.${code}`,
            frame: sample.frame,
            selector: finding.selector,
            message: `${code}${finding.source ? ` (${finding.source})` : ""}`,
          });
      if (
        sample.viewport.scrollWidth > composition.width + 1 ||
        sample.viewport.scrollHeight > composition.height + 1
      )
        issues.push({
          severity: "error",
          code: "layout.viewport_overflow",
          frame: sample.frame,
          message: `Document scroll size ${sample.viewport.scrollWidth}x${sample.viewport.scrollHeight} exceeds ${composition.width}x${composition.height}`,
        });
      if (!sample.viewport.rootBox)
        issues.push({
          severity: "error",
          code: "layout.target_missing",
          frame: sample.frame,
          selector: composition.target,
          message: "Composition target is missing after the frame became ready",
        });
      for (const message of sample.runtimeErrors)
        issues.push({
          severity: "error",
          code: "runtime.error",
          frame: sample.frame,
          message,
        });
      for (const assertion of assertions.selectors) {
        const result = sample.selectors.find(
          (item) => item.selector === assertion.selector,
        )!;
        const issue = (code: string, message: string) =>
          issues.push({
            severity: "error",
            code,
            frame: sample.frame,
            selector: assertion.selector,
            message,
          });
        if (!result.found)
          issue("selector.missing", "Selector did not match an element");
        else {
          if (assertion.visible === true && !result.visible)
            issue("layout.hidden", "Element is not visibly rendered");
          if (
            assertion.insideComposition === true &&
            result.insideComposition !== true
          )
            issue(
              "layout.outside_composition",
              "Element extends outside the composition bounds",
            );
          if (assertion.noClipping === true && result.clippedBy.length)
            issue(
              "layout.clipped",
              `Element is clipped by ${result.clippedBy.join(", ")}`,
            );
          if (
            assertion.minContrast !== undefined &&
            (result.contrast === null ||
              result.contrast < assertion.minContrast)
          )
            issue(
              "contrast.below_minimum",
              `Measured contrast ${result.contrast ?? "unknown"}; expected at least ${assertion.minContrast}`,
            );
        }
      }
    }
    const motion: AgentAuditReport["motion"] = [];
    for (const assertion of assertions.selectors.filter(
      (item) => item.motion,
    )) {
      const expected = assertion.motion!;
      const from = sampledFrames
        .find((item) => item.frame === expected.fromFrame)
        ?.selectors.find((item) => item.selector === assertion.selector)?.box;
      const to = sampledFrames
        .find((item) => item.frame === expected.toFrame)
        ?.selectors.find((item) => item.selector === assertion.selector)?.box;
      const distancePixels =
        from && to ? Math.hypot(to.x - from.x, to.y - from.y) : null;
      motion.push({
        selector: assertion.selector,
        fromFrame: expected.fromFrame,
        toFrame: expected.toFrame,
        distancePixels,
      });
      if (distancePixels === null)
        issues.push({
          severity: "error",
          code: "motion.unmeasurable",
          selector: assertion.selector,
          message: "Motion endpoints could not be measured",
        });
      else if (
        expected.minPixels !== undefined &&
        distancePixels < expected.minPixels
      )
        issues.push({
          severity: "error",
          code: "motion.below_minimum",
          selector: assertion.selector,
          message: `Moved ${distancePixels.toFixed(3)}px; expected at least ${expected.minPixels}px`,
        });
      else if (
        expected.maxPixels !== undefined &&
        distancePixels > expected.maxPixels
      )
        issues.push({
          severity: "error",
          code: "motion.above_maximum",
          selector: assertion.selector,
          message: `Moved ${distancePixels.toFixed(3)}px; expected at most ${expected.maxPixels}px`,
        });
    }
    return {
      schemaVersion: 1,
      status: issues.some((item) => item.severity === "error")
        ? "failed"
        : "passed",
      source: snapshot.session,
      browser: { executable: browser.executable },
      composition,
      sampledFrames,
      motion,
      issues,
      limits: [
        "Contrast is unmeasurable when the element-to-opaque-ancestor chain uses a CSS image/gradient or opacity. Background images behind sibling elements and antialiasing still need visual review.",
        "Clipping checks DOM rectangles and overflow ancestors; paint effects and canvas/WebGL contents are not interpreted.",
        "Motion assertions compare selector bounding-box origins at two exact frames; they do not classify animation quality.",
        "Automatic text checks inspect at most 200 visible elements with direct text per frame and warn unless --strict is set.",
      ],
    };
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    await cleanupBrowserResources(
      [
        async () => browser?.close(),
        async () => media?.close(),
        () => snapshot.close(),
      ],
      primaryFailure,
    );
  }
}

export async function auditCommand(
  config: Config,
  compositionId: string,
  options: AgentAuditOptions = {},
): Promise<AgentAuditReport> {
  const report = await auditComposition(config, compositionId, options);
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  if (options.json) write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    write(
      `Audit ${report.status}: ${compositionId} (${report.sampledFrames.map((item) => item.frame).join(", ")})\n`,
    );
    const examined = report.sampledFrames.reduce(
      (sum, item) => sum + item.automaticTextAudit.examined,
      0,
    );
    const candidates = report.sampledFrames.reduce(
      (sum, item) => sum + item.automaticTextAudit.totalCandidates,
      0,
    );
    write(
      `Automatic text audit: examined ${examined}/${candidates} frame-elements${report.sampledFrames.some((item) => item.automaticTextAudit.truncated) ? " (truncated)" : ""}\n`,
    );
    for (const issue of report.issues)
      write(
        `- ${issue.code}${issue.frame === undefined ? "" : ` frame ${issue.frame}`}${issue.selector ? ` ${issue.selector}` : ""}: ${issue.message}\n`,
      );
    if (!report.issues.length)
      write("No asserted runtime, layout, contrast, or motion failures.\n");
    write("Audit limits are included in --json output.\n");
  }
  if (report.status === "failed")
    throw new Error("audit.assertions_failed: composition check failed");
  return report;
}
