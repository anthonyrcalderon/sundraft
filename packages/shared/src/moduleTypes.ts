import type { ModuleType } from "./project";

// A single standard panel for now. Module already references moduleTypeId
// rather than embedding its own dimensions, so a real type picker can layer
// on top of this catalog later with no data model changes.
export const DEFAULT_MODULE_TYPE: ModuleType = {
  id: "standard-400w",
  name: "Standard 400W panel",
  width: 1.05, // meters, portrait orientation
  height: 1.7,
  watts: 400,
};

export const MODULE_TYPES: ModuleType[] = [DEFAULT_MODULE_TYPE];
