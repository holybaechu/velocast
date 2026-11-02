import { afterEach, expect, it, vi } from "vitest";
import { StudioApp } from "./studio-app.js";
import { BROWSER_PROTOCOL_VERSION, type CodeSource } from "@velocast/core";
import type { StudioApi, StudioSessionDescriptor } from "./studio-api.js";
import type { RpcRequest } from "./rpc-wire.js";

const apps: StudioApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  vi.unstubAllGlobals();
});

function mount(view: EventTarget) {
  const controls = new Map<string, HTMLElement>();
  const document = { createElement: () => element() };
  function element(): HTMLElement {
    return Object.assign(new EventTarget(), {
      ownerDocument: document,
      classList: { add() {} },
      setAttribute() {},
      appendChild() {},
      click: vi.fn(),
      querySelector(selector: string): HTMLElement {
        if (!controls.has(selector)) controls.set(selector, element());
        return controls.get(selector)!;
      },
    }) as unknown as HTMLElement;
  }
  const root = Object.assign(element(), {
    ownerDocument: { createElement: element },
  });
  const app = new StudioApp({ root, window: view as unknown as Window });
  apps.push(app);
  return { app, play: controls.get("[data-play]")! };
}

it("releases the Space shortcut on disposal and leaves the live app handling it", async () => {
  for (const name of [
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
  ])
    vi.stubGlobal(name, class {});
  const view = Object.assign(new EventTarget(), {
    location: { href: "http://127.0.0.1:9000/" },
    clearTimeout,
  });
  const space = () => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      code: "Space",
    });
    view.dispatchEvent(event);
    return event;
  };
  const first = mount(view);
  expect(space().defaultPrevented).toBe(true);
  expect(first.play.click).toHaveBeenCalledOnce();
  await first.app.dispose();
  expect(space().defaultPrevented).toBe(false);
  expect(first.play.click).toHaveBeenCalledOnce();

  const second = mount(view);
  expect(space().defaultPrevented).toBe(true);
  expect(first.play.click).toHaveBeenCalledOnce();
  expect(second.play.click).toHaveBeenCalledOnce();
});

function workspace(initialInputs: unknown = { title: "Saved" }) {
  const soughtFrames: number[] = [];
  const composition = {
    id: "scene",
    width: 320,
    height: 180,
    fps: 30,
    durationFrames: 60,
    target: "#root",
  };
  const compositions = [composition, { ...composition, id: "other" }];
  const view = Object.assign(new EventTarget(), {
    location: {
      href: "http://127.0.0.1:9000/",
      origin: "http://127.0.0.1:9000",
    },
    performance,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: clearTimeout,
  });
  const controls = new Map<string, HTMLElement>();
  const document = {
    createElement: (name: string) => element(name),
    defaultView: view,
  };
  function element(name = "div"): HTMLElement {
    const attributes = new Map<string, string>();
    const node = Object.assign(new EventTarget(), {
      tagName: name.toUpperCase(),
      ownerDocument: document,
      style: {},
      dataset: {} as Record<string, string>,
      classList: { add() {} },
      value: "",
      disabled: false,
      hidden: false,
      textContent: "",
      children: [] as HTMLElement[],
      clientWidth: 640,
      clientHeight: 360,
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
      getAttribute(name: string) {
        return (
          attributes.get(name) ??
          (name.startsWith("data-")
            ? node.dataset[
                name
                  .slice(5)
                  .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
              ]
            : undefined) ??
          null
        );
      },
      hasAttribute(name: string) {
        return node.getAttribute(name) !== null;
      },
      focus: vi.fn(),
      remove() {},
      getBoundingClientRect() {
        return {};
      },
      append(...children: HTMLElement[]) {
        node.children.push(...children);
      },
      replaceChildren(...children: HTMLElement[]) {
        node.children.splice(0, node.children.length, ...children);
      },
      appendChild(child: HTMLElement) {
        node.children.push(child);
        if (child.tagName === "IFRAME")
          queueMicrotask(() => child.dispatchEvent(new Event("load")));
      },
      click() {
        if (!node.disabled) node.dispatchEvent(new Event("click"));
      },
      querySelector(selector: string) {
        const child = node.querySelectorAll(selector)[0];
        if (child) return child;
        if (!controls.has(selector)) controls.set(selector, element());
        return controls.get(selector)!;
      },
      querySelectorAll(selector: string): HTMLElement[] {
        const match = (child: HTMLElement) =>
          selector.split(",").some((part) => {
            if (part.startsWith("."))
              return child.className?.split(" ").includes(part.slice(1));
            const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
            if (attribute)
              return attribute[2] === undefined
                ? child.hasAttribute(attribute[1]!)
                : child.getAttribute(attribute[1]!) === attribute[2];
            return child.tagName.toLowerCase() === part;
          });
        return node.children.flatMap((child) => [
          ...(match(child) ? [child] : []),
          ...Array.from(child.querySelectorAll<HTMLElement>(selector)),
        ]);
      },
    });
    if (name === "iframe") {
      let props: unknown;
      let selectedId = "scene";
      const target = {
        postMessage(request: RpcRequest) {
          if (request.method === "cancel") return;
          if (request.method === "seek")
            soughtFrames.push((request.payload as { frame: number }).frame);
          if (request.method === "connect")
            props = (request.payload as { inputProps: unknown }).inputProps;
          if (request.method === "initialize")
            selectedId = (request.payload as { compositionId: string })
              .compositionId;
          const failed =
            request.method === "initialize" &&
            (props as { title?: string })?.title === "bad";
          const value =
            request.method === "connect"
              ? {
                  protocolVersion: BROWSER_PROTOCOL_VERSION,
                  compositions,
                }
              : request.method === "initialize"
                ? {
                    composition: compositions.find(
                      ({ id }) =>
                        id ===
                        (request.payload as { compositionId: string })
                          .compositionId,
                    ),
                    audioPlan: null,
                  }
                : request.method === "seek"
                  ? {
                      compositionId: selectedId,
                      frame: (request.payload as { frame: number }).frame,
                    }
                  : null;
          queueMicrotask(() =>
            view.dispatchEvent(
              Object.assign(new Event("message"), {
                source: target,
                origin: "http://127.0.0.1:9001",
                data: {
                  ...request,
                  type: "response",
                  ok: !failed,
                  value,
                  ...(failed
                    ? {
                        error: {
                          name: "Error",
                          message: "inputs.title: bad title",
                        },
                      }
                    : {}),
                },
              }),
            ),
          );
        },
      };
      Object.assign(node, { contentWindow: target });
    }
    return node as unknown as HTMLElement;
  }
  let revision = 1;
  let saved: unknown = initialInputs;
  const descriptor = (): StudioSessionDescriptor => ({
    snapshotUrl: "http://127.0.0.1:9001/",
    session: {
      sessionId: `session-${revision}`,
      sourceVersion: `source-${revision}`,
    },
    inputProps: saved,
    inputPropsFile: {
      path: "C:/video/inputs.json",
      revision: `revision-${revision}`,
    },
    stagedRefresh: true,
  });
  let active = descriptor();
  let candidate: StudioSessionDescriptor | undefined;
  const api: StudioApi = {
    getSession: async () => active,
    refresh: async () => (active = descriptor()),
    prepareRefresh: async () => (candidate = descriptor()),
    commitRefresh: async () => (active = candidate!),
    discardRefresh: async () => active,
    getInputs: async () => ({
      enabled: true,
      path: "C:/video/inputs.json",
      revision: `revision-${revision}`,
      inputProps: saved,
    }),
    saveInputs: async (request) => {
      if (request.expectedRevision !== `revision-${revision}`)
        throw new Error("studio.api_http_409: studio.inputs_conflict");
      saved = request.inputProps;
      revision++;
      return api.getInputs!();
    },
    output: async () => ({ outputPath: "frame.png" }),
  };
  const app = new StudioApp({
    root: element(),
    api,
    window: view as unknown as Window,
  });
  apps.push(app);
  const control = <T extends HTMLElement = HTMLElement>(selector: string) =>
    controls.get(selector)! as T;
  const edit = (text: string) => {
    const input = control<HTMLTextAreaElement>("[data-inputs]");
    input.value = text;
    input.dispatchEvent(new Event("input"));
  };
  const properties = () =>
    new Map(
      Array.from(control("[data-properties-form]").children).flatMap((label) =>
        Array.from(label.children)
          .filter((child) => child.getAttribute("data-input-prop") !== null)
          .map(
            (child) =>
              [
                child.getAttribute("data-input-prop")!,
                child as HTMLInputElement,
              ] as const,
          ),
      ),
    );
  return { app, api, view, control, edit, soughtFrames, properties };
}

it("keeps an unsaved human draft when an agent changes saved inputs and requires an explicit reload", async () => {
  const f = workspace();
  await f.app.start();
  expect(f.control("[data-error]").textContent).toBe("");
  f.edit('{"title":"Human draft"}');
  expect(f.control("[data-inputs-status]").textContent).toContain(
    "Unsaved changes",
  );
  await f.api.saveInputs!({
    expectedSourceVersion: "source-1",
    expectedRevision: "revision-1",
    inputProps: { title: "Agent edit" },
  });
  f.control("[data-refresh]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-inputs-status]").textContent).toContain(
      "Your draft is kept",
    ),
  );
  expect(f.control<HTMLTextAreaElement>("[data-inputs]").value).toBe(
    '{"title":"Human draft"}',
  );
  expect(f.control<HTMLButtonElement>("[data-save-inputs]").disabled).toBe(
    true,
  );
  expect(f.control("[data-inputs-status]").textContent).toContain(
    "Your draft is kept",
  );
  f.control("[data-reload-inputs]").click();
  await vi.waitFor(() =>
    expect(f.control<HTMLTextAreaElement>("[data-inputs]").value).toContain(
      "Agent edit",
    ),
  );
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-reload-inputs]").disabled).toBe(
      false,
    ),
  );
  f.edit('{"title":"Combined edit"}');
  f.control("[data-save-inputs]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-inputs-status]").textContent).toContain(
      "Saved and applied",
    ),
  );
  expect((await f.api.getInputs!()).inputProps).toEqual({
    title: "Combined edit",
  });
  expect((await f.api.getInputs!()).revision).toBe("revision-3");
});

it.each(["Edited source", "bad"])(
  "holds code exports until a saved source edit reaches a valid displayed build: %s",
  async (title) => {
    vi.useFakeTimers();
    try {
      const f = workspace();
      let source: CodeSource = {
        enabled: true,
        compositionId: "scene",
        path: "src/Scene.tsx",
        revision: "file-1",
        canUndo: false,
        canRedo: false,
        elements: [
          {
            id: "title",
            name: "Title",
            kind: "layer",
            line: 10,
            fields: {
              text: { value: "Hello", editable: true },
              from: { value: 0, editable: true },
            },
          },
        ],
      };
      f.api.getCode = async () => source;
      const getSession = f.api.getSession;
      f.api.getSession = async () => ({
        ...(await getSession()),
        sourceRevision: "build-1",
        codeRevisions: { scene: "file-1" },
      });
      f.api.changes = async () => ({ enabled: true, revision: "build-2" });
      const oldSession = await f.api.getSession();
      const prepareRefresh = f.api.prepareRefresh!;
      f.api.prepareRefresh = vi
        .fn()
        .mockResolvedValueOnce(oldSession)
        .mockImplementation(async (version: string, signal?: AbortSignal) => ({
          ...(await prepareRefresh(version, signal)),
          codeRevisions: { scene: "file-2" },
        }));
      const save = vi.fn<NonNullable<StudioApi["saveCode"]>>(async () => {
        source = {
          ...source,
          revision: "file-2",
          canUndo: true,
          elements: [
            {
              ...source.elements[0]!,
              fields: {
                ...source.elements[0]!.fields,
                text: { value: title, editable: true },
              },
            },
          ],
        };
        await f.api.saveInputs!({
          expectedSourceVersion: "source-1",
          expectedRevision: "revision-1",
          inputProps: { title },
        });
        return source;
      });
      f.api.saveCode = save;
      await f.app.start();
      const inspector = f.control("[data-project-inspector]");
      const field = inspector.querySelector<HTMLTextAreaElement>(
        '[data-code-field="text"]',
      )!;
      field.value = title;
      field.dispatchEvent(new Event("input"));
      expect(f.control("[data-inputs-status]").textContent).toContain(
        "Unsaved",
      );
      expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
        true,
      );
      inspector.querySelector<HTMLButtonElement>("[data-code-save]")!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledWith(
        {
          compositionId: "scene",
          expectedSourceVersion: "source-1",
          expectedRevision: "file-1",
          edits: [{ id: "title", field: "text", value: title }],
        },
        expect.any(AbortSignal),
      );
      expect(f.control("[data-inputs-status]").textContent).toContain(
        "waiting for completed build",
      );
      expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(1500);
      if (title === "bad") {
        expect(f.control("[data-inputs-status]").textContent).toContain(
          "could not be displayed",
        );
        expect(f.control("[data-error]").textContent).toContain("inputs.title");
        expect(
          f.control<HTMLButtonElement>("[data-output-video]").disabled,
        ).toBe(true);
      } else {
        expect(f.control("[data-inputs-status]").textContent).toBe(
          "Saved and displayed",
        );
        expect(
          f.control<HTMLButtonElement>("[data-output-video]").disabled,
        ).toBe(false);
      }
      await f.app.dispose();
    } finally {
      vi.useRealTimers();
    }
  },
);

function literalSource(
  compositionId = "scene",
  revision = "file-2",
): CodeSource {
  return {
    enabled: true,
    compositionId,
    path: `src/${compositionId}.tsx`,
    revision,
    canUndo: false,
    canRedo: false,
    elements: [
      {
        id: "title",
        name: "Title",
        kind: "layer",
        line: 10,
        fields: {
          text: { value: "Saved text", editable: true },
          from: { value: 0, editable: true },
        },
      },
    ],
  };
}

it("keeps rejected literal-edit errors visible until the invalid draft is discarded", async () => {
  const f = workspace();
  const source = literalSource("scene", "file-1");
  source.elements[0]!.fields.durationFrames = { value: 60, editable: true };
  f.api.getCode = async () => source;
  const getSession = f.api.getSession;
  f.api.getSession = async () => ({
    ...(await getSession()),
    codeRevisions: { scene: "file-1" },
  });
  f.api.saveCode = async () => {
    throw new Error(
      "studio.api_http_400: studio.code_value: durationFrames must be nonnegative",
    );
  };
  await f.app.start();
  const inspector = f.control("[data-project-inspector]");
  const duration = inspector.querySelector<HTMLInputElement>(
    '[data-code-field="durationFrames"]',
  )!;
  duration.value = "-1";
  duration.dispatchEvent(new Event("input"));
  inspector.querySelector<HTMLButtonElement>("[data-code-save]")!.click();
  await vi.waitFor(() =>
    expect(f.control("[data-error]").textContent).toContain(
      "durationFrames must be nonnegative",
    ),
  );
  await vi.waitFor(() =>
    expect(
      inspector.querySelector<HTMLButtonElement>("[data-code-discard]")!
        .disabled,
    ).toBe(false),
  );
  expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
    true,
  );
  inspector.querySelector<HTMLButtonElement>("[data-code-discard]")!.click();
  expect(f.control("[data-error]").textContent).toBe("");
  expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
    false,
  );
});

it.each(["file-1", undefined])(
  "blocks stale code on initial load and explains missing build receipts: %s",
  async (receipt) => {
    const f = workspace();
    f.api.getCode = async (id) => ({
      ...literalSource(id),
      displayedRevision: "file-2",
    });
    const getSession = f.api.getSession;
    f.api.getSession = async () => ({
      ...(await getSession()),
      ...(receipt ? { codeRevisions: { scene: receipt } } : {}),
    });
    await f.app.start();
    expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
      true,
    );
    expect(f.control("[data-inputs-status]").textContent).toContain(
      receipt ? "waiting for completed build" : "studioSourcePlugin",
    );
    const text = f
      .control("[data-project-inspector]")
      .querySelector<HTMLInputElement>('[data-code-field="text"]')!;
    expect(text.disabled).toBe(!receipt);
  },
);

it("accepts a comment-only source revision only when its completed build receipt is displayed", async () => {
  vi.useFakeTimers();
  try {
    const f = workspace();
    let revision = "file-1";
    f.api.getCode = async (id) => ({
      ...literalSource(id, revision),
      displayedRevision: revision,
    });
    const getSession = f.api.getSession;
    f.api.getSession = async () => ({
      ...(await getSession()),
      sourceRevision: "build-1",
      codeRevisions: { scene: "file-1" },
    });
    f.api.changes = async () => ({ enabled: true, revision: "build-2" });
    const prepare = f.api.prepareRefresh!;
    f.api.prepareRefresh = async (version, signal) => ({
      ...(await prepare(version, signal)),
      session: { sessionId: "comments", sourceVersion: "receipt-2" },
      sourceRevision: "build-2",
      codeRevisions: { scene: "file-2" },
    });
    await f.app.start();
    revision = "file-2";
    await vi.advanceTimersByTimeAsync(750);
    expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(750);
    expect(f.control("[data-inputs-status]").textContent).toBe(
      "Saved and displayed",
    );
    expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
      false,
    );
    await f.app.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["pending", "failed"])(
  "does not lose a %s source receipt when switching away and back or refreshing an unchanged build",
  async (phase) => {
    const f = workspace();
    f.api.getCode = async (id) =>
      literalSource(id, id === "scene" ? "file-2" : "other-1");
    const getSession = f.api.getSession;
    const receipts = { scene: "file-1", other: "other-1" };
    f.api.getSession = async () => ({
      ...(await getSession()),
      codeRevisions: receipts,
    });
    const prepare = f.api.prepareRefresh!;
    let fail = phase === "failed";
    f.api.prepareRefresh = async (version, signal) => {
      const candidate = await prepare(version, signal);
      if (fail) {
        fail = false;
        return {
          ...candidate,
          session: { sessionId: "failed-build", sourceVersion: "failed-build" },
          inputProps: { title: "bad" },
          codeRevisions: { ...receipts, scene: "file-2" },
        };
      }
      return { ...candidate, codeRevisions: receipts };
    };
    await f.app.start();
    if (phase === "failed") {
      f.control("[data-refresh]").click();
      await vi.waitFor(() =>
        expect(f.control("[data-error]").textContent).toContain("inputs.title"),
      );
      await vi.waitFor(() =>
        expect(f.control<HTMLButtonElement>("[data-refresh]").disabled).toBe(
          false,
        ),
      );
    }
    const selector = f.control<HTMLSelectElement>("[data-composition]");
    selector.value = "other";
    selector.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(f.control("[data-selected-composition]").textContent).toBe(
        "other",
      ),
    );
    await vi.waitFor(() => expect(selector.disabled).toBe(false));
    selector.value = "scene";
    selector.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(f.control("[data-selected-composition]").textContent).toBe(
        "scene",
      ),
    );
    await vi.waitFor(() => expect(selector.disabled).toBe(false));
    expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
      true,
    );
    expect(f.control("[data-inputs-status]").textContent).toContain(
      phase === "failed"
        ? "could not be displayed"
        : "waiting for completed build",
    );
    f.control("[data-refresh]").click();
    await vi.waitFor(() =>
      expect(f.control<HTMLButtonElement>("[data-refresh]").disabled).toBe(
        false,
      ),
    );
    expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
      true,
    );
  },
);

it.each(["refresh_busy", "output_busy", "build_in_progress"])(
  "retries automatic source refresh after temporary %s contention",
  async (code) => {
    vi.useFakeTimers();
    try {
      const f = workspace();
      const getSession = f.api.getSession;
      f.api.getSession = async () => ({
        ...(await getSession()),
        sourceRevision: "build-1",
      });
      f.api.changes = async () => ({ enabled: true, revision: "build-2" });
      const prepareRefresh = f.api.prepareRefresh!;
      const prepare = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(`studio.api_http_409: studio.${code}: active work`),
        )
        .mockImplementation(prepareRefresh);
      f.api.prepareRefresh = prepare;
      await f.app.start();
      f.edit('{"title":"Human draft"}');
      await vi.advanceTimersByTimeAsync(1500);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(f.control("[data-error]").textContent).toBe("");
      await vi.advanceTimersByTimeAsync(1500);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(f.control<HTMLTextAreaElement>("[data-inputs]").value).toBe(
        '{"title":"Human draft"}',
      );
      await f.app.dispose();
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["Saved during build", "bad"])(
  "keeps a successful save pending during compilation and reports its eventual load result: %s",
  async (title) => {
    vi.useFakeTimers();
    try {
      const f = workspace();
      const getSession = f.api.getSession;
      f.api.getSession = async () => ({
        ...(await getSession()),
        sourceRevision: "build-1",
      });
      f.api.changes = async () => ({ enabled: true, revision: "build-2" });
      const prepareRefresh = f.api.prepareRefresh!;
      f.api.prepareRefresh = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "studio.api_http_409: studio.build_in_progress: waiting for compilation",
          ),
        )
        .mockImplementation(prepareRefresh);
      await f.app.start();
      f.edit(JSON.stringify({ title }));
      f.control("[data-save-inputs]").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.control("[data-inputs-status]").textContent).toBe(
        "Saved; waiting for completed build",
      );
      expect(f.control("[data-error]").textContent).toBe("");
      expect(f.control("[data-reload-inputs]").hidden).toBe(true);
      expect((await f.api.getInputs!()).inputProps).toEqual({ title });
      await vi.advanceTimersByTimeAsync(1500);
      if (title === "bad") {
        expect(f.control("[data-inputs-status]").textContent).toContain(
          "could not load",
        );
        expect(f.control("[data-error]").textContent).toContain("inputs.title");
        expect(f.control("[data-reload-inputs]").hidden).toBe(false);
      } else {
        expect(f.control("[data-inputs-status]").textContent).toBe(
          "Saved and applied",
        );
        expect(f.control("[data-reload-inputs]").hidden).toBe(true);
      }
      await f.app.dispose();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("provides keyboard-accessible Properties and Export tabs with one visible inspector panel", async () => {
  const f = workspace();
  const tab = (name: string) =>
    f.control<HTMLButtonElement>(`[data-inspector-tab="${name}"]`);
  const panel = (name: string) => f.control(`[data-inspector-panel="${name}"]`);
  expect(tab("properties").getAttribute("aria-selected")).toBe("true");
  expect(panel("properties").hidden).toBe(false);
  expect(panel("export").hidden).toBe(true);
  tab("export").click();
  expect(tab("properties").tabIndex).toBe(-1);
  expect(tab("export").tabIndex).toBe(0);
  expect(panel("properties").hidden).toBe(true);
  expect(panel("export").hidden).toBe(false);
  const next = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "Home",
  });
  tab("export").dispatchEvent(next);
  expect(next.defaultPrevented).toBe(true);
  expect(tab("properties").getAttribute("aria-selected")).toBe("true");
  expect(tab("properties").focus).toHaveBeenCalledOnce();
  f.control("[data-show-export]").click();
  expect(panel("export").hidden).toBe(false);
});

it("keeps composition navigation and the compact selector on the same selected composition", async () => {
  const f = workspace();
  await f.app.start();
  const items = Array.from(
    f.control("[data-composition-list]").children,
  ) as HTMLButtonElement[];
  expect(items).toHaveLength(2);
  expect(items[0]!.getAttribute("aria-pressed")).toBe("true");
  items[1]!.click();
  await vi.waitFor(() =>
    expect(f.control("[data-selected-composition]").textContent).toBe("other"),
  );
  await vi.waitFor(() =>
    expect(f.control<HTMLSelectElement>("[data-composition]").disabled).toBe(
      false,
    ),
  );
  expect(items[1]!.getAttribute("aria-pressed")).toBe("true");
  expect(items[0]!.getAttribute("aria-pressed")).toBe("false");
  const select = f.control<HTMLSelectElement>("[data-composition]");
  expect(select.value).toBe("other");
  select.value = "scene";
  select.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(f.control("[data-selected-composition]").textContent).toBe("scene"),
  );
  expect(items[0]!.getAttribute("aria-pressed")).toBe("true");
});

it("retains the working studio after saved inputs fail composition validation and can recover", async () => {
  const f = workspace();
  await f.app.start();
  f.edit('{"title":"bad"}');
  f.control("[data-save-inputs]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-inputs-status]").textContent).toContain(
      "could not load",
    ),
  );
  expect((await f.api.getInputs!()).inputProps).toEqual({ title: "bad" });
  expect(f.control("[data-selected-composition]").textContent).toBe("scene");
  expect(f.control("[data-error]").textContent).toContain("inputs.title");
  f.edit('{"title":"Recovered"}');
  f.control("[data-save-inputs]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-inputs-status]").textContent).toContain(
      "Saved and applied",
    ),
  );
});

it("seeks exact frames and window bounds while leaving editing shortcuts alone", async () => {
  const f = workspace();
  await f.app.start();
  const input = f.control<HTMLInputElement>("[data-exact-frame]");
  input.value = "12";
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(f.control("[data-frame]").textContent).toContain("0012"),
  );
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-next-frame]").disabled).toBe(
      false,
    ),
  );
  f.control("[data-next-frame]").click();
  expect(f.control("[data-error]").textContent).toBe("");
  await vi.waitFor(() =>
    expect(f.control("[data-frame]").textContent).toContain("0013"),
  );
  f.control<HTMLInputElement>("[data-range-start]").value = "10";
  f.control<HTMLInputElement>("[data-range-end]").value = "20";
  f.control("[data-apply-range]").click();
  await vi.waitFor(() => expect(input.max).toBe("19"));
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-last-frame]").disabled).toBe(
      false,
    ),
  );
  f.control("[data-last-frame]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-frame]").textContent).toContain("0019"),
  );
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-first-frame]").disabled).toBe(
      false,
    ),
  );
  f.control("[data-first-frame]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-frame]").textContent).toContain("0010"),
  );
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-previous-frame]").disabled).toBe(
      false,
    ),
  );
  f.control("[data-previous-frame]").click();
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-previous-frame]").disabled).toBe(
      false,
    ),
  );
  expect(f.control("[data-frame]").textContent).toContain("0010");
  expect(f.control("[data-error]").textContent).toBe("");
  const editing = Object.assign(new Event("keydown", { cancelable: true }), {
    code: "Space",
  });
  Object.defineProperty(editing, "target", { value: { tagName: "TEXTAREA" } });
  f.view.dispatchEvent(editing);
  expect(editing.defaultPrevented).toBe(false);
});

it("commits an exact frame on Enter once, even when the browser also emits change", async () => {
  const f = workspace();
  await f.app.start();
  const input = f.control<HTMLInputElement>("[data-exact-frame]");
  const previousSeeks = f.soughtFrames.length;
  input.value = "45";
  const enter = Object.assign(new Event("keydown", { cancelable: true }), {
    key: "Enter",
    code: "Enter",
  });
  input.dispatchEvent(enter);
  await vi.waitFor(() =>
    expect(f.control("[data-frame]").textContent).toContain("0045"),
  );
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-previous-frame]").disabled).toBe(
      false,
    ),
  );
  expect(enter.defaultPrevented).toBe(true);
  expect(f.soughtFrames.slice(previousSeeks)).toEqual([45]);
  input.dispatchEvent(new Event("change"));
  await Promise.resolve();
  expect(f.soughtFrames.slice(previousSeeks)).toEqual([45]);
});

it("shows the published artifact when a user cancellation loses the publication race", async () => {
  const f = workspace();
  let finish!: () => void;
  f.api.output = async (_request, signal, progress) => {
    progress?.({ id: "published-job", status: "running" });
    await new Promise<void>((resolve) => {
      signal!.addEventListener(
        "abort",
        () => {
          finish = resolve;
        },
        { once: true },
      );
    });
    progress?.({ id: "published-job", status: "succeeded" });
    return {
      outputPath: "published.png",
      url: "http://127.0.0.1:9000/artifacts/published.png",
    };
  };
  await f.app.start();
  f.control("[data-output-frame]").click();
  f.control("[data-cancel-output]").click();
  expect(f.control("[data-output]").textContent).toContain(
    "waiting for job cleanup",
  );
  expect(f.control("[data-output]").children).toHaveLength(0);
  finish();
  await vi.waitFor(() =>
    expect(f.control("[data-output]").children).toHaveLength(1),
  );
  const children = Array.from(f.control("[data-output]").children);
  expect((children[0] as HTMLAnchorElement).href).toBe(
    "http://127.0.0.1:9000/artifacts/published.png",
  );
  expect(f.control<HTMLButtonElement>("[data-cancel-output]").hidden).toBe(
    true,
  );
});

it.each(["save", "reload"])(
  "enables exports when the %s input operation finishes",
  async (operation) => {
    const f = workspace();
    await f.app.start();
    if (operation === "save") f.edit('{"title":"Ready to export"}');
    f.control(
      operation === "save" ? "[data-save-inputs]" : "[data-reload-inputs]",
    ).click();
    await vi.waitFor(() =>
      expect(
        f.control<HTMLButtonElement>("[data-reload-inputs]").disabled,
      ).toBe(false),
    );
    expect(f.control("[data-status]").textContent).toBe("Frame ready");
    expect(f.control<HTMLButtonElement>("[data-output-frame]").disabled).toBe(
      false,
    );
    expect(f.control<HTMLButtonElement>("[data-output-range]").disabled).toBe(
      false,
    );
  },
);

it("edits primitive properties through the same JSON draft and preserves nested values when saved", async () => {
  const f = workspace({
    title: "Saved",
    accentColor: "#123456",
    count: 2.5,
    enabled: true,
    nested: { items: [1, 2] },
    array: ["keep"],
  });
  await f.app.start();
  const fields = f.properties();
  expect([...fields.keys()]).toEqual([
    "title",
    "accentColor",
    "count",
    "enabled",
  ]);
  expect(fields.get("accentColor")!.type).toBe("color");
  expect(fields.get("count")!.type).toBe("number");
  expect(fields.get("enabled")!.checked).toBe(true);
  fields.get("title")!.value = "From the form";
  fields.get("title")!.dispatchEvent(new Event("input"));
  fields.get("count")!.value = "";
  fields.get("count")!.dispatchEvent(new Event("input"));
  expect(f.control<HTMLButtonElement>("[data-save-inputs]").disabled).toBe(
    true,
  );
  expect(
    JSON.parse(f.control<HTMLTextAreaElement>("[data-inputs]").value).count,
  ).toBe(2.5);
  expect(fields.get("count")!.value).toBe("");
  fields.get("title")!.value = "From the form";
  fields.get("title")!.dispatchEvent(new Event("input"));
  expect(fields.get("count")!.value).toBe("");
  expect(f.control<HTMLButtonElement>("[data-save-inputs]").disabled).toBe(
    true,
  );
  fields.get("count")!.value = "7.25";
  fields.get("count")!.dispatchEvent(new Event("input"));
  fields.get("enabled")!.checked = false;
  fields.get("enabled")!.dispatchEvent(new Event("input"));
  fields.get("accentColor")!.value = "#abcdef";
  fields.get("accentColor")!.dispatchEvent(new Event("input"));
  const expected = {
    title: "From the form",
    accentColor: "#abcdef",
    count: 7.25,
    enabled: false,
    nested: { items: [1, 2] },
    array: ["keep"],
  };
  expect(
    JSON.parse(f.control<HTMLTextAreaElement>("[data-inputs]").value),
  ).toEqual(expected);
  f.control("[data-save-inputs]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-inputs-status]").textContent).toBe(
      "Saved and applied",
    ),
  );
  expect((await f.api.getInputs!()).inputProps).toEqual(expected);
});

it("keeps a text control while typing long or hex text, and synchronizes valid raw JSON without losing an invalid draft", async () => {
  const f = workspace();
  await f.app.start();
  const title = f.properties().get("title")!;
  title.value = "a".repeat(110);
  title.dispatchEvent(new Event("input"));
  expect(f.properties().get("title")).toBe(title);
  title.value = "#123456";
  title.dispatchEvent(new Event("input"));
  expect(f.properties().get("title")).toBe(title);
  expect(title.type).toBe("text");
  f.edit("{");
  expect(title.disabled).toBe(true);
  expect(f.control<HTMLTextAreaElement>("[data-inputs]").value).toBe("{");
  expect(f.control<HTMLButtonElement>("[data-save-inputs]").disabled).toBe(
    true,
  );
  title.value = "must not replace JSON";
  title.dispatchEvent(new Event("input"));
  expect(f.control<HTMLTextAreaElement>("[data-inputs]").value).toBe("{");
  f.edit('{"title":"Raw edit","nested":{"enabled":true}}');
  expect(f.properties().get("title")!.value).toBe("Raw edit");
  expect(f.properties().get("title")!.disabled).toBe(false);
  const input = f.control<HTMLInputElement>("[data-exact-frame]");
  input.value = "12";
  input.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(f.control("[data-frame]").textContent).toContain("0012"),
  );
  expect(f.properties().get("title")!.value).toBe("Raw edit");
  expect(
    JSON.parse(f.control<HTMLTextAreaElement>("[data-inputs]").value).nested,
  ).toEqual({ enabled: true });
});

it("keeps an incomplete numeric draft when another editor refreshes saved inputs", async () => {
  const f = workspace({ count: 2, title: "Saved" });
  await f.app.start();
  const count = f.properties().get("count")!;
  count.value = "";
  count.dispatchEvent(new Event("input"));
  await f.api.saveInputs!({
    expectedSourceVersion: "source-1",
    expectedRevision: "revision-1",
    inputProps: { count: 3, title: "Agent edit" },
  });
  f.control("[data-refresh]").click();
  await vi.waitFor(() =>
    expect(f.control("[data-inputs-status]").textContent).toContain(
      "Your draft is kept",
    ),
  );
  expect(count.value).toBe("");
  expect(f.control("[data-inputs-status]").textContent).toContain(
    "Your draft is kept",
  );
  expect(f.control<HTMLButtonElement>("[data-save-inputs]").disabled).toBe(
    true,
  );
  f.control("[data-reload-inputs]").click();
  await vi.waitFor(() => expect(count.value).toBe("3"));
});

it("exports the complete composition independently of the playback range", async () => {
  const f = workspace();
  const output = vi.fn<StudioApi["output"]>(async () => ({
    outputPath: "complete.mp4",
    url: "http://127.0.0.1:9000/artifacts/complete.mp4",
  }));
  f.api.output = output;
  await f.app.start();
  f.control<HTMLInputElement>("[data-range-start]").value = "10";
  f.control<HTMLInputElement>("[data-range-end]").value = "20";
  f.control("[data-apply-range]").click();
  await vi.waitFor(() =>
    expect(f.control<HTMLInputElement>("[data-seek]").max).toBe("19"),
  );
  await vi.waitFor(() =>
    expect(f.control<HTMLButtonElement>("[data-output-video]").disabled).toBe(
      false,
    ),
  );
  f.control("[data-output-video]").click();
  await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
  expect(output.mock.calls[0]![0]).toMatchObject({
    compositionId: "scene",
    range: { start: 0, end: 60 },
  });
  expect(f.control<HTMLInputElement>("[data-seek]").min).toBe("10");
  expect(f.control<HTMLInputElement>("[data-seek]").max).toBe("19");
  await vi.waitFor(() =>
    expect(f.control("[data-output]").children).toHaveLength(1),
  );
  expect(
    (f.control("[data-output]").children[0] as HTMLAnchorElement).href,
  ).toContain("complete.mp4");
});
