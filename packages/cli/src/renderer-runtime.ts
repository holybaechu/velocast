import {
  electronRuntimeEnvironment,
  inspectElectronRuntime,
} from "./electron-runtime.js";
import {
  ArtifactResolver,
  type ResolvedReleaseRuntime,
} from "./artifact-resolver.js";
import {
  RendererRuntimeResolver,
  type RendererRuntime,
  type ResolveRendererBinaryOptions,
} from "./renderer-binary.js";

export interface AcquiredRendererRuntime extends RendererRuntime {
  source: "local" | ResolvedReleaseRuntime["source"];
}

export interface RendererRuntimeAcquisitionOptions extends ResolveRendererBinaryOptions {
  runtimeResolver?: Pick<RendererRuntimeResolver, "resolveProcessEnv"> & {
    resolveBinary(configuredBinary?: string): string | undefined;
  } & Partial<Pick<RendererRuntimeResolver, "inspectProcessEnv">>;
  resolveRendererBinary?: (configuredBinary?: string) => string | undefined;
  artifactResolver?: Pick<ArtifactResolver, "inspect"> &
    Partial<Pick<ArtifactResolver, "setup">>;
}

/** Owns runtime precedence and launch context; artifact verification stays in
 * ArtifactResolver and developer discovery stays in RendererRuntimeResolver. */
export class RendererRuntimeAcquisition {
  private readonly local: NonNullable<
    RendererRuntimeAcquisitionOptions["runtimeResolver"]
  >;
  private artifacts: RendererRuntimeAcquisitionOptions["artifactResolver"];

  constructor(
    private readonly options: RendererRuntimeAcquisitionOptions = {},
  ) {
    this.local =
      options.runtimeResolver ?? new RendererRuntimeResolver(options);
    this.artifacts = options.artifactResolver;
  }

  /** Reports existing/source facts without preparing files. A local source
   * environment may need staging; call acquire() before launching a renderer. */
  inspect(configuredBinary?: string): AcquiredRendererRuntime | undefined {
    const local = this.resolveLocal(configuredBinary, false);
    if (local) return local;
    if (!this.allowsManagedRuntime(configuredBinary)) return undefined;
    const managed = this.artifactResolver().inspect();
    return managed ? this.managedRuntime(managed) : undefined;
  }

  async acquire(configuredBinary?: string): Promise<AcquiredRendererRuntime> {
    const local = this.resolveLocal(configuredBinary);
    if (local) return local;
    if (!this.allowsManagedRuntime(configuredBinary)) {
      throw new Error(
        "renderer.binary_unavailable: the explicit renderer could not be resolved",
      );
    }
    const artifacts = this.artifactResolver();
    if (!artifacts.setup) {
      throw new Error(
        "renderer.setup_unavailable: runtime adapter only supports inspection",
      );
    }
    return this.managedRuntime(await artifacts.setup());
  }

  private resolveLocal(
    configuredBinary?: string,
    prepare = true,
  ): AcquiredRendererRuntime | undefined {
    let binary: string | undefined;
    try {
      binary = this.options.resolveRendererBinary
        ? this.options.resolveRendererBinary(configuredBinary)
        : this.local.resolveBinary(configuredBinary);
    } catch (error) {
      if (
        !this.allowsManagedRuntime(configuredBinary) ||
        !(error instanceof Error) ||
        !error.message.startsWith("renderer.binary_unavailable:")
      ) {
        throw error;
      }
    }
    if (binary === undefined) return undefined;
    return {
      binary,
      // Legacy adapters may only implement preparation. Do not invoke those
      // side effects while inspecting; report the caller's existing environment.
      env: prepare
        ? this.local.resolveProcessEnv(binary)
        : (this.local.inspectProcessEnv?.(binary) ?? {
            ...(this.options.env ?? process.env),
          }),
      source: "local",
    };
  }

  private allowsManagedRuntime(configuredBinary?: string): boolean {
    const env = this.options.env ?? process.env;
    return (
      (configuredBinary === undefined || configuredBinary === "auto") &&
      !env.VELOCAST_RENDERER_BINARY?.trim()
    );
  }

  private artifactResolver(): NonNullable<
    RendererRuntimeAcquisitionOptions["artifactResolver"]
  > {
    return (this.artifacts ??= new ArtifactResolver({
      env: this.options.env,
      platform: this.options.platform,
      arch: this.options.arch,
    }));
  }

  private managedRuntime(
    runtime: ResolvedReleaseRuntime,
  ): AcquiredRendererRuntime {
    const env: NodeJS.ProcessEnv = {
      ...(this.options.env ?? process.env),
      VELOCAST_RENDERER_BINARY: runtime.rendererBinary,
    };
    const electron = inspectElectronRuntime(
      runtime.rendererBinary,
      this.options.platform ?? process.platform,
      this.options.arch ?? process.arch,
    );
    if (electron)
      return {
        binary: runtime.rendererBinary,
        env: electronRuntimeEnvironment(
          electron,
          env,
          this.options.platform ?? process.platform,
        ),
        source: runtime.source,
      };
    throw new Error(
      "runtime.electron_invalid: verified renderer artifact is missing electron-runtime.json",
    );
  }
}
