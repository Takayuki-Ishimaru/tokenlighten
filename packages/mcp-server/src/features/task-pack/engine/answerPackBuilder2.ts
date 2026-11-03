// answerPackBuilder — extracted implementation; imports point to the owning modules.
import type { AnswerFirstFacts } from "../answerFirstFacts.js";
import type { NamedWindow } from "./callableResolution2.js";
import type { StructureMapMember } from "../structureMap.js";
import type { StructureMapType } from "../structureMap.js";

// ---------------------------------------------------------------------------
// v0.16 6t-7 T03 (2026-10-20): the STRUCTURE MAP answer. structureMap.ts holds
// the projection and its selection wording; these wire it into the answer
// pack: `structureMapForAnswer` decides it (before the facet hook, which plans
// the flow facets against it), `renderStructureMapSurface` serves it on the
// primary surface, and `structureMapStateTypeSurfaces` adds the enum types the
// type's header is declared in.
// ---------------------------------------------------------------------------

export interface LineWindow {
  readonly start: number;
  readonly end: number;
  readonly path?: string;
}

export interface StructureMapFileLayout {
  readonly path: string;
  readonly type: StructureMapType;
  readonly rows: readonly LineWindow[];
  readonly requiredWindows: readonly LineWindow[];
  readonly owed: readonly LineWindow[];
  readonly header?: LineWindow;
}

/** The structure map an answer pack serves for its primary type. */
export interface AnswerStructureMap {
  readonly type: StructureMapType;
  /**
   * The words whose call statements the map serves: every flow facet's own
   * call terms plus the request's named concerns (`requiredQueryFacets`) — a
   * superset of what any facet's plan requires (`flowStepWindowsForNonCallableFocal`).
   */
  readonly terms: readonly string[];
  /** The rows the primary surface serves, in source order (`structureMapRows`). */
  readonly rows: readonly LineWindow[];
  /** Full map evidence requirements, independent of the selected wire page. */
  readonly requiredWindows: readonly LineWindow[];
  readonly stateWindows: readonly NamedWindow[];
  /** Every other line of the type: the planner's remainder and the comment blocks the rows were split at. */
  readonly owed: readonly LineWindow[];
  /** The map's header window, whose type names find the enum types. */
  readonly header?: LineWindow;
  /** The reply's estimated bytes with the map (`estimateStructureMapReplyBytes`)… */
  readonly replyBytes: number;
  /** …and the pack's byte cap it was admitted under; the enum types take only what is left. */
  readonly capBytes: number;
  /** TL_EFF_MAP_ANSWER_FIRST: set when the map is the CORE evidence alone (`answerFirstStructureMap`). */
  readonly answerFirst?: AnswerFirstPlan;
  /** Stage 2: one separately grounded map layout per source file. */
  readonly fileLayouts?: readonly StructureMapFileLayout[];
  /** Matching definitions in safely examined but unselected C++ source files. */
  readonly otherMemberFiles?: ReadonlyArray<{ readonly path: string; readonly count: number }>;
}

/** What an answer-first map served and what it left owed (the source of the reply's advisory). */
export interface AnswerFirstPlan {
  /** The members whose whole bodies are the page (`coverMembers`). */
  readonly cover: readonly StructureMapMember[];
  /** The constructors' bodies were left owed to make room (`StructureMapPlanOptions.constructorsLast`). */
  readonly constructorsLast: boolean;
  /** What the reply states about the unserved bodies, before it is fitted to the room the pack has left. */
  readonly facts: AnswerFirstFacts;
  /** The pack as planned, in bytes (rows, enum types and the envelope reserve): what stands for its size where the size preview does not apply. */
  readonly estimateBytes: number;
}
