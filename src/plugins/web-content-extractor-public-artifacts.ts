import { isRecord } from "../shared/record-coerce.js";
import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import type {
  PluginWebContentExtractorEntry,
  WebContentExtractorPlugin,
} from "./web-content-extractor-types.js";

const WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES = [
  "web-content-extractor.js",
  "web-content-extractor-api.js",
] as const;

function isWebContentExtractorPlugin(value: unknown): value is WebContentExtractorPlugin {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.autoDetectOrder === undefined || typeof value.autoDetectOrder === "number") &&
    typeof value.extract === "function"
  );
}

function readStringField(value: WebContentExtractorPlugin, field: string): string | undefined {
  try {
    const fieldValue = (value as Record<string, unknown>)[field];
    return typeof fieldValue === "string" ? fieldValue : undefined;
  } catch {
    return undefined;
  }
}

function readAutoDetectOrder(value: WebContentExtractorPlugin): number | undefined {
  try {
    const fieldValue = (value as Record<string, unknown>).autoDetectOrder;
    return typeof fieldValue === "number" ? fieldValue : undefined;
  } catch {
    return undefined;
  }
}

function readExtract(
  value: WebContentExtractorPlugin,
): WebContentExtractorPlugin["extract"] | undefined {
  try {
    const fieldValue = (value as Record<string, unknown>).extract;
    return typeof fieldValue === "function"
      ? (fieldValue as WebContentExtractorPlugin["extract"])
      : undefined;
  } catch {
    return undefined;
  }
}

function copyReadableWebContentExtractorFields(
  extractor: WebContentExtractorPlugin,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(extractor);
  } catch {
    return fields;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !descriptor.enumerable ||
      key === "id" ||
      key === "label" ||
      key === "autoDetectOrder" ||
      key === "extract" ||
      key === "pluginId"
    ) {
      continue;
    }
    try {
      fields[key] = (extractor as Record<string, unknown>)[key];
    } catch {
      // Unreadable plugin-owned optional metadata is treated as absent.
    }
  }
  return fields;
}

function createWebContentExtractorEntry(params: {
  extractor: WebContentExtractorPlugin;
  pluginId: string;
}): PluginWebContentExtractorEntry | undefined {
  const id = readStringField(params.extractor, "id");
  const label = readStringField(params.extractor, "label");
  const autoDetectOrder = readAutoDetectOrder(params.extractor);
  const extract = readExtract(params.extractor);
  if (id === undefined || label === undefined || extract === undefined) {
    return undefined;
  }
  return {
    ...copyReadableWebContentExtractorFields(params.extractor),
    id,
    label,
    ...(autoDetectOrder === undefined ? {} : { autoDetectOrder }),
    extract,
    pluginId: params.pluginId,
  } as PluginWebContentExtractorEntry;
}

function tryLoadBundledPublicArtifactModule(params: {
  dirName: string;
}): Record<string, unknown> | null {
  for (const artifactBasename of WEB_CONTENT_EXTRACTOR_ARTIFACT_CANDIDATES) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<Record<string, unknown>>({
        dirName: params.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

function collectExtractorFactories(params: { mod: Record<string, unknown>; pluginId: string }): {
  extractors: PluginWebContentExtractorEntry[];
  errors: unknown[];
} {
  const extractors: PluginWebContentExtractorEntry[] = [];
  const errors: unknown[] = [];
  for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      typeof exported !== "function" ||
      exported.length !== 0 ||
      !name.startsWith("create") ||
      !name.endsWith("WebContentExtractor")
    ) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = exported();
    } catch (error) {
      errors.push(error);
      continue;
    }
    let extractor: WebContentExtractorPlugin | undefined;
    try {
      extractor = isWebContentExtractorPlugin(candidate) ? candidate : undefined;
    } catch (error) {
      errors.push(error);
      continue;
    }
    if (extractor) {
      const entry = createWebContentExtractorEntry({
        extractor,
        pluginId: params.pluginId,
      });
      if (entry) {
        extractors.push(entry);
      }
    }
  }
  return { extractors, errors };
}

export function loadBundledWebContentExtractorEntriesFromDir(params: {
  dirName: string;
  pluginId: string;
}): PluginWebContentExtractorEntry[] | null {
  const mod = tryLoadBundledPublicArtifactModule({ dirName: params.dirName });
  if (!mod) {
    return null;
  }
  const { extractors, errors } = collectExtractorFactories({
    mod,
    pluginId: params.pluginId,
  });
  if (extractors.length === 0) {
    if (errors.length > 0) {
      throw new Error(`Unable to initialize web content extractors for plugin ${params.pluginId}`, {
        cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
      });
    }
    return null;
  }
  return extractors;
}
