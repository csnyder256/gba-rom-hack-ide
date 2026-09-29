import { createDesktopApiFetch } from './desktop-api-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  GET_WORKSPACE_SUMMARY_DESCRIPTION,
  GET_WORKSPACE_SUMMARY_TOOL_NAME,
  getWorkspaceSummary,
  getWorkspaceSummaryInputShape,
  getWorkspaceSummaryOutputShape,
} from './tools/get-workspace-summary.js';
import {
  FIND_REFERENCES_TO_DESCRIPTION,
  FIND_REFERENCES_TO_TOOL_NAME,
  findReferencesTo,
  findReferencesToInputShape,
} from './tools/find-references-to.js';
import {
  READ_MAP_DESCRIPTION,
  READ_MAP_TOOL_NAME,
  readMap,
  readMapInputShape,
} from './tools/read-map.js';
import {
  READ_DECODED_SCRIPT_DESCRIPTION,
  READ_DECODED_SCRIPT_TOOL_NAME,
  readDecodedScript,
  readDecodedScriptInputShape,
} from './tools/read-decoded-script.js';
import {
  LIST_ENTITIES_DESCRIPTION,
  LIST_ENTITIES_TOOL_NAME,
  listEntities,
  listEntitiesInputShape,
} from './tools/list-entities.js';
import {
  PROPOSE_PATCH_DESCRIPTION,
  PROPOSE_PATCH_TOOL_NAME,
  proposePatch,
  proposePatchInputShape,
} from './tools/propose-patch.js';
import {
  PROPOSE_RENAME_DESCRIPTION,
  PROPOSE_RENAME_TOOL_NAME,
  proposeRename,
  proposeRenameInputShape,
} from './tools/propose-rename.js';
import {
  LIST_SPECIES_LIBRARIES_DESCRIPTION,
  LIST_SPECIES_LIBRARIES_TOOL_NAME,
  listSpeciesLibraries,
  listSpeciesLibrariesInputShape,
} from './tools/list-species-libraries.js';
import {
  GET_SPECIES_FROM_LIBRARY_DESCRIPTION,
  GET_SPECIES_FROM_LIBRARY_TOOL_NAME,
  getSpeciesFromLibrary,
  getSpeciesFromLibraryInputShape,
} from './tools/get-species-from-library.js';
import {
  IMPORT_SPECIES_FROM_LIBRARY_DESCRIPTION,
  IMPORT_SPECIES_FROM_LIBRARY_TOOL_NAME,
  importSpeciesFromLibrary,
  importSpeciesFromLibraryInputShape,
} from './tools/import-species-from-library.js';
import {
  GET_DETECTION_REPORT_DESCRIPTION,
  GET_DETECTION_REPORT_TOOL_NAME,
  getDetectionReport,
  getDetectionReportInputShape,
} from './tools/get-detection-report.js';
import {
  AUDIT_MAP_RENDERING_DESCRIPTION,
  AUDIT_MAP_RENDERING_TOOL_NAME,
  auditMapRendering,
  auditMapRenderingInputShape,
} from './tools/audit-map-rendering.js';
import {
  PROPOSE_SPECIES_EDIT_DESCRIPTION,
  PROPOSE_SPECIES_EDIT_TOOL_NAME,
  proposeSpeciesEdit,
  proposeSpeciesEditInputShape,
} from './tools/propose-species-edit.js';
import {
  PROPOSE_MOVE_EDIT_DESCRIPTION,
  PROPOSE_MOVE_EDIT_TOOL_NAME,
  proposeMoveEdit,
  proposeMoveEditInputShape,
} from './tools/propose-move-edit.js';
import {
  PROPOSE_ITEM_EDIT_DESCRIPTION,
  PROPOSE_ITEM_EDIT_TOOL_NAME,
  proposeItemEdit,
  proposeItemEditInputShape,
} from './tools/propose-item-edit.js';
import {
  PROPOSE_ENCOUNTER_EDIT_DESCRIPTION,
  PROPOSE_ENCOUNTER_EDIT_TOOL_NAME,
  proposeEncounterEdit,
  proposeEncounterEditInputShape,
} from './tools/propose-encounter-edit.js';
import {
  PROPOSE_TRAINER_PARTY_DESCRIPTION,
  PROPOSE_TRAINER_PARTY_TOOL_NAME,
  proposeTrainerParty,
  proposeTrainerPartyInputShape,
} from './tools/propose-trainer-party.js';
import {
  PROPOSE_ADD_OBJECT_EVENT_DESCRIPTION,
  PROPOSE_ADD_OBJECT_EVENT_TOOL_NAME,
  proposeAddObjectEvent,
  proposeAddObjectEventInputShape,
} from './tools/propose-add-object-event.js';
import {
  PROPOSE_ADD_TRAINER_DESCRIPTION,
  PROPOSE_ADD_TRAINER_TOOL_NAME,
  proposeAddTrainer,
  proposeAddTrainerInputShape,
} from './tools/propose-add-trainer.js';
import {
  PROPOSE_ADD_SCRIPT_FOR_TRAINER_DESCRIPTION,
  PROPOSE_ADD_SCRIPT_FOR_TRAINER_TOOL_NAME,
  proposeAddScriptForTrainer,
  proposeAddScriptForTrainerInputShape,
} from './tools/propose-add-script-for-trainer.js';
import {
  PROPOSE_SCRIPT_EDIT_DESCRIPTION,
  PROPOSE_SCRIPT_EDIT_TOOL_NAME,
  proposeScriptEdit,
  proposeScriptEditInputShape,
} from './tools/propose-script-edit.js';
import {
  PROPOSE_ENCOUNTER_TABLE_EDIT_DESCRIPTION,
  PROPOSE_ENCOUNTER_TABLE_EDIT_TOOL_NAME,
  proposeEncounterTableEdit,
  proposeEncounterTableEditInputShape,
  normaliseEncounterTableEditArgs,
} from './tools/propose-encounter-table-edit.js';
import {
  READ_IMAGE_DESCRIPTION,
  READ_IMAGE_TOOL_NAME,
  readImage,
  readImageInputShape,
} from './tools/read-image.js';
import {
  PROPOSE_EDITOR_EXTENSION_DESCRIPTION,
  PROPOSE_EDITOR_EXTENSION_TOOL_NAME,
  proposeEditorExtension,
  proposeEditorExtensionInputShape,
} from './tools/propose-editor-extension.js';
import {
  PROPOSE_STORY_SPEC_DESCRIPTION,
  PROPOSE_STORY_SPEC_TOOL_NAME,
  proposeStorySpec,
  proposeStorySpecInputShape,
} from './tools/propose-story-spec.js';
import {
  PROPOSE_DIALOGUE_BRANCH_ON_VAR_DESCRIPTION,
  PROPOSE_DIALOGUE_BRANCH_ON_VAR_TOOL_NAME,
  proposeDialogueBranchOnVar,
  proposeDialogueBranchOnVarInputShape,
} from './tools/propose-dialogue-branch-on-var.js';
import {
  PROPOSE_LEVEL_CAP_TABLE_DESCRIPTION,
  PROPOSE_LEVEL_CAP_TABLE_TOOL_NAME,
  proposeLevelCapTable,
  proposeLevelCapTableInputShape,
} from './tools/propose-level-cap-table.js';
import {
  PROPOSE_FORM_CHANGE_RULE_DESCRIPTION,
  PROPOSE_FORM_CHANGE_RULE_TOOL_NAME,
  proposeFormChangeRule,
  proposeFormChangeRuleInputShape,
} from './tools/propose-form-change-rule.js';
import {
  PROPOSE_CREATE_MAP_DESCRIPTION,
  PROPOSE_CREATE_MAP_TOOL_NAME,
  proposeCreateMap,
  proposeCreateMapInputShape,
} from './tools/propose-create-map.js';
import {
  PROPOSE_PAINT_MAP_BLOCKS_DESCRIPTION,
  PROPOSE_PAINT_MAP_BLOCKS_TOOL_NAME,
  proposePaintMapBlocks,
  proposePaintMapBlocksInputShape,
} from './tools/propose-paint-map-blocks.js';
import {
  PROPOSE_SET_MAP_CONNECTION_DESCRIPTION,
  PROPOSE_SET_MAP_CONNECTION_TOOL_NAME,
  proposeSetMapConnection,
  proposeSetMapConnectionInputShape,
} from './tools/propose-set-map-connection.js';
import {
  PROPOSE_SET_BORDER_BLOCK_DESCRIPTION,
  PROPOSE_SET_BORDER_BLOCK_TOOL_NAME,
  proposeSetBorderBlock,
  proposeSetBorderBlockInputShape,
} from './tools/propose-set-border-block.js';
import {
  PROPOSE_SET_MAP_METADATA_DESCRIPTION,
  PROPOSE_SET_MAP_METADATA_TOOL_NAME,
  proposeSetMapMetadata,
  proposeSetMapMetadataInputShape,
} from './tools/propose-set-map-metadata.js';
import {
  PROPOSE_SEED_SAVE_STATE_DESCRIPTION,
  PROPOSE_SEED_SAVE_STATE_TOOL_NAME,
  proposeSeedSaveState,
  proposeSeedSaveStateInputShape,
} from './tools/propose-seed-save-state.js';
import {
  PROPOSE_BUILD_TRAINER_TEAM_DESCRIPTION,
  PROPOSE_BUILD_TRAINER_TEAM_TOOL_NAME,
  proposeBuildTrainerTeam,
  proposeBuildTrainerTeamInputShape,
} from './tools/propose-build-trainer-team.js';
import {
  PROPOSE_CHARACTER_VOICE_CARD_DESCRIPTION,
  PROPOSE_CHARACTER_VOICE_CARD_TOOL_NAME,
  proposeCharacterVoiceCard,
  proposeCharacterVoiceCardInputShape,
} from './tools/propose-character-voice-card.js';
import {
  PROPOSE_GENERATE_DIALOGUE_DESCRIPTION,
  PROPOSE_GENERATE_DIALOGUE_TOOL_NAME,
  proposeGenerateDialogue,
  proposeGenerateDialogueInputShape,
} from './tools/propose-generate-dialogue.js';
import {
  PROPOSE_GENERATE_MAP_SKELETON_DESCRIPTION,
  PROPOSE_GENERATE_MAP_SKELETON_TOOL_NAME,
  proposeGenerateMapSkeleton,
  proposeGenerateMapSkeletonInputShape,
} from './tools/propose-generate-map-skeleton.js';
import {
  PROPOSE_RESOLVE_MAP_SKELETON_DESCRIPTION,
  PROPOSE_RESOLVE_MAP_SKELETON_TOOL_NAME,
  proposeResolveMapSkeleton,
  proposeResolveMapSkeletonInputShape,
} from './tools/propose-resolve-map-skeleton.js';
import {
  PROPOSE_VALIDATE_MAP_TRAVERSAL_DESCRIPTION,
  PROPOSE_VALIDATE_MAP_TRAVERSAL_TOOL_NAME,
  proposeValidateMapTraversal,
  proposeValidateMapTraversalInputShape,
} from './tools/propose-validate-map-traversal.js';
import {
  PROPOSE_SUGGEST_TILE_NEIGHBORS_DESCRIPTION,
  PROPOSE_SUGGEST_TILE_NEIGHBORS_TOOL_NAME,
  proposeSuggestTileNeighbors,
  proposeSuggestTileNeighborsInputShape,
} from './tools/propose-suggest-tile-neighbors.js';
import {
  PROPOSE_COMPLETE_REGION_DESCRIPTION,
  PROPOSE_COMPLETE_REGION_TOOL_NAME,
  proposeCompleteRegion,
  proposeCompleteRegionInputShape,
} from './tools/propose-complete-region.js';
import {
  PROPOSE_BROWSE_TILESET_LIBRARY_DESCRIPTION,
  PROPOSE_BROWSE_TILESET_LIBRARY_TOOL_NAME,
  proposeBrowseTilesetLibrary,
  proposeBrowseTilesetLibraryInputShape,
} from './tools/propose-browse-tileset-library.js';
import {
  PROPOSE_APPLY_TEMPLATE_DESCRIPTION,
  PROPOSE_APPLY_TEMPLATE_TOOL_NAME,
  proposeApplyTemplate,
  proposeApplyTemplateInputShape,
} from './tools/propose-apply-template.js';
import {
  PROPOSE_CHECK_STORY_COHERENCE_DESCRIPTION,
  PROPOSE_CHECK_STORY_COHERENCE_TOOL_NAME,
  proposeCheckStoryCoherence,
  proposeCheckStoryCoherenceInputShape,
} from './tools/propose-check-story-coherence.js';
import {
  PROPOSE_SET_REGION_MAP_LABEL_DESCRIPTION,
  PROPOSE_SET_REGION_MAP_LABEL_TOOL_NAME,
  proposeSetRegionMapLabel,
  proposeSetRegionMapLabelInputShape,
} from './tools/propose-set-region-map-label.js';
import {
  PROPOSE_EDIT_EVOLUTION_DESCRIPTION,
  PROPOSE_EDIT_EVOLUTION_TOOL_NAME,
  proposeEditEvolution,
  proposeEditEvolutionInputShape,
} from './tools/propose-edit-evolution.js';
import {
  PROPOSE_GENERATE_README_DESCRIPTION,
  PROPOSE_GENERATE_README_TOOL_NAME,
  proposeGenerateReadme,
  proposeGenerateReadmeInputShape,
} from './tools/propose-generate-readme.js';
import {
  PROPOSE_IMPORT_OVERWORLD_SPRITE_DESCRIPTION,
  PROPOSE_IMPORT_OVERWORLD_SPRITE_TOOL_NAME,
  proposeImportOverworldSprite,
  proposeImportOverworldSpriteInputShape,
} from './tools/propose-import-overworld-sprite.js';
import {
  PROPOSE_IMPORT_TILESET_DESCRIPTION,
  PROPOSE_IMPORT_TILESET_TOOL_NAME,
  proposeImportTileset,
  proposeImportTilesetInputShape,
} from './tools/propose-import-tileset.js';
import {
  PROPOSE_CUTSCENE_DESCRIPTION,
  PROPOSE_CUTSCENE_TOOL_NAME,
  proposeCutscene,
  proposeCutsceneInputShape,
} from './tools/propose-cutscene.js';
import {
  PROPOSE_IMPORT_TRAINER_SPRITE_DESCRIPTION,
  PROPOSE_IMPORT_TRAINER_SPRITE_TOOL_NAME,
  proposeImportTrainerSprite,
  proposeImportTrainerSpriteInputShape,
} from './tools/propose-import-trainer-sprite.js';
import {
  PROPOSE_IMPORT_PORTRAIT_DESCRIPTION,
  PROPOSE_IMPORT_PORTRAIT_TOOL_NAME,
  proposeImportPortrait,
  proposeImportPortraitInputShape,
} from './tools/propose-import-portrait.js';
import {
  PROPOSE_IMPORT_POKEMON_SPRITE_DESCRIPTION,
  PROPOSE_IMPORT_POKEMON_SPRITE_TOOL_NAME,
  proposeImportPokemonSprite,
  proposeImportPokemonSpriteInputShape,
} from './tools/propose-import-pokemon-sprite.js';
import {
  PROPOSE_BATCH_APPLY_DESCRIPTION,
  PROPOSE_BATCH_APPLY_TOOL_NAME,
  proposeBatchApply,
  proposeBatchApplyInputShape,
} from './tools/propose-batch-apply.js';
import {
  PROPOSE_TEST_SCENE_DESCRIPTION,
  PROPOSE_TEST_SCENE_TOOL_NAME,
  proposeTestScene,
  proposeTestSceneInputShape,
} from './tools/propose-test-scene.js';
import {
  PROPOSE_AUTHOR_SCENE_DESCRIPTION,
  PROPOSE_AUTHOR_SCENE_TOOL_NAME,
  proposeAuthorScene,
  proposeAuthorSceneInputShape,
} from './tools/propose-author-scene.js';
import {
  PROPOSE_POKEDEX_ENTRY_DESCRIPTION,
  PROPOSE_POKEDEX_ENTRY_TOOL_NAME,
  proposePokedexEntry,
  proposePokedexEntryInputShape,
} from './tools/propose-pokedex-entry.js';
import {
  PROPOSE_ADD_SPECIES_DESCRIPTION,
  PROPOSE_ADD_SPECIES_TOOL_NAME,
  proposeAddSpecies,
  proposeAddSpeciesInputShape,
} from './tools/propose-add-species.js';
import {
  PROPOSE_EDIT_ABILITY_DESCRIPTION,
  PROPOSE_EDIT_ABILITY_TOOL_NAME,
  proposeEditAbility,
  proposeEditAbilityInputShape,
} from './tools/propose-edit-ability.js';
import {
  PROPOSE_EDIT_CREDITS_DESCRIPTION,
  PROPOSE_EDIT_CREDITS_TOOL_NAME,
  proposeEditCredits,
  proposeEditCreditsInputShape,
} from './tools/propose-edit-credits.js';
import {
  PROPOSE_SET_FLY_DESTINATION_DESCRIPTION,
  PROPOSE_SET_FLY_DESTINATION_TOOL_NAME,
  proposeSetFlyDestination,
  proposeSetFlyDestinationInputShape,
} from './tools/propose-set-fly-destination.js';
import {
  PROPOSE_IMPORT_MUSIC_DESCRIPTION,
  PROPOSE_IMPORT_MUSIC_TOOL_NAME,
  proposeImportMusic,
  proposeImportMusicInputShape,
} from './tools/propose-import-music.js';
import {
  PROPOSE_SET_SOUND_EFFECT_DESCRIPTION,
  PROPOSE_SET_SOUND_EFFECT_TOOL_NAME,
  PROPOSE_SET_CRY_DESCRIPTION,
  PROPOSE_SET_CRY_TOOL_NAME,
  proposeSetCry,
  proposeSetCryInputShape,
  proposeSetSoundEffect,
  proposeSetSoundEffectInputShape,
} from './tools/propose-import-audio-sample.js';
import {
  PROPOSE_TEST_PATCH_DESCRIPTION,
  PROPOSE_TEST_PATCH_TOOL_NAME,
  proposeTestPatch,
  proposeTestPatchInputShape,
} from './tools/propose-test-patch.js';
import {
  PROPOSE_SET_TITLE_SCREEN_DESCRIPTION,
  PROPOSE_SET_TITLE_SCREEN_TOOL_NAME,
  proposeSetTitleScreen,
  proposeSetTitleScreenInputShape,
} from './tools/propose-set-title-screen.js';
import {
  PROPOSE_SET_BATTLE_UI_DESCRIPTION,
  PROPOSE_SET_BATTLE_UI_TOOL_NAME,
  proposeSetBattleUi,
  proposeSetBattleUiInputShape,
} from './tools/propose-set-battle-ui.js';
import {
  PROPOSE_CREATE_TRAINER_CLASS_DESCRIPTION,
  PROPOSE_CREATE_TRAINER_CLASS_TOOL_NAME,
  proposeCreateTrainerClass,
  proposeCreateTrainerClassInputShape,
} from './tools/propose-create-trainer-class.js';
import {
  PROPOSE_CREATE_ITEM_DESCRIPTION,
  PROPOSE_CREATE_ITEM_TOOL_NAME,
  proposeCreateItem,
  proposeCreateItemInputShape,
} from './tools/propose-create-item.js';
import {
  PROPOSE_EDIT_MART_DESCRIPTION,
  PROPOSE_EDIT_MART_TOOL_NAME,
  proposeEditMart,
  proposeEditMartInputShape,
} from './tools/propose-edit-mart.js';
import type { ToolContext } from './types.js';

const SERVER_INFO = {
  name: 'rom-editor-agent',
  version: '0.1.0',
} as const;

function textResult<T>(value: T): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as unknown as Record<string, unknown>,
  };
}

export function createAgentMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    GET_WORKSPACE_SUMMARY_TOOL_NAME,
    {
      title: 'Get workspace summary',
      description: GET_WORKSPACE_SUMMARY_DESCRIPTION,
      inputSchema: getWorkspaceSummaryInputShape,
      outputSchema: getWorkspaceSummaryOutputShape,
    },
    async () => textResult(await getWorkspaceSummary(ctx)),
  );

  server.registerTool(
    FIND_REFERENCES_TO_TOOL_NAME,
    {
      title: 'Find references to entity',
      description: FIND_REFERENCES_TO_DESCRIPTION,
      inputSchema: findReferencesToInputShape,
    },
    async (args) => textResult(await findReferencesTo(ctx, args)),
  );

  server.registerTool(
    READ_MAP_TOOL_NAME,
    {
      title: 'Read map',
      description: READ_MAP_DESCRIPTION,
      inputSchema: readMapInputShape,
    },
    async (args) => textResult(await readMap(ctx, args)),
  );

  server.registerTool(
    READ_DECODED_SCRIPT_TOOL_NAME,
    {
      title: 'Read decoded script',
      description: READ_DECODED_SCRIPT_DESCRIPTION,
      inputSchema: readDecodedScriptInputShape,
    },
    async (args) => textResult(await readDecodedScript(ctx, args)),
  );

  server.registerTool(
    LIST_ENTITIES_TOOL_NAME,
    {
      title: 'List entities',
      description: LIST_ENTITIES_DESCRIPTION,
      inputSchema: listEntitiesInputShape,
    },
    async (args) => textResult(await listEntities(ctx, args)),
  );

  server.registerTool(
    PROPOSE_PATCH_TOOL_NAME,
    {
      title: 'Propose a patch',
      description: PROPOSE_PATCH_DESCRIPTION,
      inputSchema: proposePatchInputShape,
    },
    async (args) => textResult(await proposePatch(ctx, args)),
  );

  server.registerTool(
    PROPOSE_RENAME_TOOL_NAME,
    {
      title: 'Propose a rename',
      description: PROPOSE_RENAME_DESCRIPTION,
      inputSchema: proposeRenameInputShape,
    },
    async (args) => textResult(await proposeRename(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SCRIPT_EDIT_TOOL_NAME,
    {
      title: 'Edit a script (insert / delete / modify steps)',
      description: PROPOSE_SCRIPT_EDIT_DESCRIPTION,
      inputSchema: proposeScriptEditInputShape,
    },
    async (args) => textResult(await proposeScriptEdit(ctx, args)),
  );

  server.registerTool(
    PROPOSE_ENCOUNTER_TABLE_EDIT_TOOL_NAME,
    {
      title: 'Edit an encounter table (rate / reorder / bulk-replace)',
      description: PROPOSE_ENCOUNTER_TABLE_EDIT_DESCRIPTION,
      inputSchema: proposeEncounterTableEditInputShape,
    },
    async (args) => textResult(await proposeEncounterTableEdit(ctx, normaliseEncounterTableEditArgs(args))),
  );

  server.registerTool(
    LIST_SPECIES_LIBRARIES_TOOL_NAME,
    {
      title: 'List species libraries',
      description: LIST_SPECIES_LIBRARIES_DESCRIPTION,
      inputSchema: listSpeciesLibrariesInputShape,
    },
    async () => textResult(await listSpeciesLibraries(ctx)),
  );

  server.registerTool(
    GET_SPECIES_FROM_LIBRARY_TOOL_NAME,
    {
      title: 'Get species from library',
      description: GET_SPECIES_FROM_LIBRARY_DESCRIPTION,
      inputSchema: getSpeciesFromLibraryInputShape,
    },
    async (args) => textResult(await getSpeciesFromLibrary(ctx, args)),
  );

  server.registerTool(
    IMPORT_SPECIES_FROM_LIBRARY_TOOL_NAME,
    {
      title: 'Import species from library',
      description: IMPORT_SPECIES_FROM_LIBRARY_DESCRIPTION,
      inputSchema: importSpeciesFromLibraryInputShape,
    },
    async (args) => textResult(await importSpeciesFromLibrary(ctx, args)),
  );

  server.registerTool(
    GET_DETECTION_REPORT_TOOL_NAME,
    {
      title: 'Get detection report',
      description: GET_DETECTION_REPORT_DESCRIPTION,
      inputSchema: getDetectionReportInputShape,
    },
    async () => textResult(await getDetectionReport(ctx)),
  );

  server.registerTool(
    AUDIT_MAP_RENDERING_TOOL_NAME,
    {
      title: 'Audit map rendering',
      description: AUDIT_MAP_RENDERING_DESCRIPTION,
      inputSchema: auditMapRenderingInputShape,
    },
    async () => textResult(await auditMapRendering(ctx)),
  );

  server.registerTool(
    PROPOSE_SPECIES_EDIT_TOOL_NAME,
    {
      title: 'Edit species (stats/types/abilities/etc.)',
      description: PROPOSE_SPECIES_EDIT_DESCRIPTION,
      inputSchema: proposeSpeciesEditInputShape,
    },
    async (args) => textResult(await proposeSpeciesEdit(ctx, args)),
  );

  server.registerTool(
    PROPOSE_MOVE_EDIT_TOOL_NAME,
    {
      title: 'Edit move (power/accuracy/type/PP/etc.)',
      description: PROPOSE_MOVE_EDIT_DESCRIPTION,
      inputSchema: proposeMoveEditInputShape,
    },
    async (args) => textResult(await proposeMoveEdit(ctx, args)),
  );

  server.registerTool(
    PROPOSE_ITEM_EDIT_TOOL_NAME,
    {
      title: 'Edit item (price/hold-effect/pocket/etc.)',
      description: PROPOSE_ITEM_EDIT_DESCRIPTION,
      inputSchema: proposeItemEditInputShape,
    },
    async (args) => textResult(await proposeItemEdit(ctx, args)),
  );

  server.registerTool(
    PROPOSE_ENCOUNTER_EDIT_TOOL_NAME,
    {
      title: 'Edit encounter table slots',
      description: PROPOSE_ENCOUNTER_EDIT_DESCRIPTION,
      inputSchema: proposeEncounterEditInputShape,
    },
    async (args) => textResult(await proposeEncounterEdit(ctx, args)),
  );

  server.registerTool(
    PROPOSE_TRAINER_PARTY_TOOL_NAME,
    {
      title: 'Edit trainer party member',
      description: PROPOSE_TRAINER_PARTY_DESCRIPTION,
      inputSchema: proposeTrainerPartyInputShape,
    },
    async (args) => textResult(await proposeTrainerParty(ctx, args)),
  );

  server.registerTool(
    PROPOSE_ADD_OBJECT_EVENT_TOOL_NAME,
    {
      title: 'Add a new ObjectEvent (NPC) to a map',
      description: PROPOSE_ADD_OBJECT_EVENT_DESCRIPTION,
      inputSchema: proposeAddObjectEventInputShape,
    },
    async (args) => textResult(await proposeAddObjectEvent(ctx, args)),
  );

  server.registerTool(
    PROPOSE_ADD_TRAINER_TOOL_NAME,
    {
      title: 'Add a new trainer to the gTrainers table',
      description: PROPOSE_ADD_TRAINER_DESCRIPTION,
      inputSchema: proposeAddTrainerInputShape,
    },
    async (args) => textResult(await proposeAddTrainer(ctx, args)),
  );

  server.registerTool(
    PROPOSE_ADD_SCRIPT_FOR_TRAINER_TOOL_NAME,
    {
      title: 'Bind an NPC to a trainer (synthesizes trainerbattle script)',
      description: PROPOSE_ADD_SCRIPT_FOR_TRAINER_DESCRIPTION,
      inputSchema: proposeAddScriptForTrainerInputShape,
    },
    async (args) => textResult(await proposeAddScriptForTrainer(ctx, args)),
  );

  server.registerTool(
    PROPOSE_EDITOR_EXTENSION_TOOL_NAME,
    {
      title: 'Propose editor extension (asks user to enable dev mode)',
      description: PROPOSE_EDITOR_EXTENSION_DESCRIPTION,
      inputSchema: proposeEditorExtensionInputShape,
    },
    async (args) => textResult(await proposeEditorExtension(ctx, args)),
  );

  server.registerTool(
    PROPOSE_STORY_SPEC_TOOL_NAME,
    {
      title: 'Propose story spec (multi-act narrative plan)',
      description: PROPOSE_STORY_SPEC_DESCRIPTION,
      inputSchema: proposeStorySpecInputShape,
    },
    async (args) => textResult(await proposeStorySpec(ctx, args)),
  );

  server.registerTool(
    PROPOSE_DIALOGUE_BRANCH_ON_VAR_TOOL_NAME,
    {
      title: 'Branch dialogue on a story variable',
      description: PROPOSE_DIALOGUE_BRANCH_ON_VAR_DESCRIPTION,
      inputSchema: proposeDialogueBranchOnVarInputShape,
    },
    async (args) => textResult(await proposeDialogueBranchOnVar(ctx, args)),
  );

  server.registerTool(
    PROPOSE_LEVEL_CAP_TABLE_TOOL_NAME,
    {
      title: 'Set per-badge level cap (CFRU source edit)',
      description: PROPOSE_LEVEL_CAP_TABLE_DESCRIPTION,
      inputSchema: proposeLevelCapTableInputShape,
    },
    async (args) => textResult(await proposeLevelCapTable(ctx, args)),
  );

  server.registerTool(
    PROPOSE_FORM_CHANGE_RULE_TOOL_NAME,
    {
      title: 'Register a held-item form change',
      description: PROPOSE_FORM_CHANGE_RULE_DESCRIPTION,
      inputSchema: proposeFormChangeRuleInputShape,
    },
    async (args) => textResult(await proposeFormChangeRule(ctx, args)),
  );

  server.registerTool(
    PROPOSE_CREATE_MAP_TOOL_NAME,
    {
      title: 'Create a new map (Phase 3.8)',
      description: PROPOSE_CREATE_MAP_DESCRIPTION,
      inputSchema: proposeCreateMapInputShape,
    },
    async (args) => textResult(await proposeCreateMap(ctx, args)),
  );

  server.registerTool(
    PROPOSE_PAINT_MAP_BLOCKS_TOOL_NAME,
    {
      title: 'Paint metatile blocks onto a map (Phase 3.9)',
      description: PROPOSE_PAINT_MAP_BLOCKS_DESCRIPTION,
      inputSchema: proposePaintMapBlocksInputShape,
    },
    async (args) => textResult(await proposePaintMapBlocks(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_MAP_CONNECTION_TOOL_NAME,
    {
      title: 'Wire a directional map connection (Phase 3.10)',
      description: PROPOSE_SET_MAP_CONNECTION_DESCRIPTION,
      inputSchema: proposeSetMapConnectionInputShape,
    },
    async (args) => textResult(await proposeSetMapConnection(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_BORDER_BLOCK_TOOL_NAME,
    {
      title: 'Set the 2×2 border bezel of a map (Phase 3.11)',
      description: PROPOSE_SET_BORDER_BLOCK_DESCRIPTION,
      inputSchema: proposeSetBorderBlockInputShape,
    },
    async (args) => textResult(await proposeSetBorderBlock(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_MAP_METADATA_TOOL_NAME,
    {
      title: 'Set per-map metadata (Phase 3.12)',
      description: PROPOSE_SET_MAP_METADATA_DESCRIPTION,
      inputSchema: proposeSetMapMetadataInputShape,
    },
    async (args) => textResult(await proposeSetMapMetadata(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SEED_SAVE_STATE_TOOL_NAME,
    {
      title: 'Persist a scene-boot recipe (Phase 4.1E)',
      description: PROPOSE_SEED_SAVE_STATE_DESCRIPTION,
      inputSchema: proposeSeedSaveStateInputShape,
    },
    async (args) => textResult(await proposeSeedSaveState(ctx, args)),
  );

  server.registerTool(
    PROPOSE_BUILD_TRAINER_TEAM_TOOL_NAME,
    {
      title: 'Build a balanced trainer team (Phase 3.18)',
      description: PROPOSE_BUILD_TRAINER_TEAM_DESCRIPTION,
      inputSchema: proposeBuildTrainerTeamInputShape,
    },
    async (args) => textResult(await proposeBuildTrainerTeam(ctx, args)),
  );

  server.registerTool(
    PROPOSE_CHARACTER_VOICE_CARD_TOOL_NAME,
    {
      title: 'Persist character voice card (Phase 3.21)',
      description: PROPOSE_CHARACTER_VOICE_CARD_DESCRIPTION,
      inputSchema: proposeCharacterVoiceCardInputShape,
    },
    async (args) => textResult(await proposeCharacterVoiceCard(ctx, args)),
  );

  server.registerTool(
    PROPOSE_GENERATE_DIALOGUE_TOOL_NAME,
    {
      title: 'Generate dialogue honoring a voice card (Phase 3.22)',
      description: PROPOSE_GENERATE_DIALOGUE_DESCRIPTION,
      inputSchema: proposeGenerateDialogueInputShape,
    },
    async (args) => textResult(await proposeGenerateDialogue(ctx, args)),
  );

  server.registerTool(
    PROPOSE_GENERATE_MAP_SKELETON_TOOL_NAME,
    {
      title: 'Generate a map outline from theme + biome (Phase 8G-1)',
      description: PROPOSE_GENERATE_MAP_SKELETON_DESCRIPTION,
      inputSchema: proposeGenerateMapSkeletonInputShape,
    },
    async (args) => textResult(await proposeGenerateMapSkeleton(ctx, args)),
  );

  server.registerTool(
    PROPOSE_RESOLVE_MAP_SKELETON_TOOL_NAME,
    {
      title: 'Resolve a map outline into a paint plan (Phase 8G-2)',
      description: PROPOSE_RESOLVE_MAP_SKELETON_DESCRIPTION,
      inputSchema: proposeResolveMapSkeletonInputShape,
    },
    async (args) => textResult(await proposeResolveMapSkeleton(ctx, args)),
  );

  server.registerTool(
    PROPOSE_VALIDATE_MAP_TRAVERSAL_TOOL_NAME,
    {
      title: 'Validate a resolved map\'s traversal (Phase 8G-3)',
      description: PROPOSE_VALIDATE_MAP_TRAVERSAL_DESCRIPTION,
      inputSchema: proposeValidateMapTraversalInputShape,
    },
    async (args) => textResult(await proposeValidateMapTraversal(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SUGGEST_TILE_NEIGHBORS_TOOL_NAME,
    {
      title: 'Suggest legal tile neighbours (Phase 8H-1)',
      description: PROPOSE_SUGGEST_TILE_NEIGHBORS_DESCRIPTION,
      inputSchema: proposeSuggestTileNeighborsInputShape,
    },
    async (args) => textResult(await proposeSuggestTileNeighbors(ctx, args)),
  );

  server.registerTool(
    PROPOSE_COMPLETE_REGION_TOOL_NAME,
    {
      title: 'Auto-fill a map region with consistent tiles (Phase 8H-2)',
      description: PROPOSE_COMPLETE_REGION_DESCRIPTION,
      inputSchema: proposeCompleteRegionInputShape,
    },
    async (args) => textResult(await proposeCompleteRegion(ctx, args)),
  );

  server.registerTool(
    PROPOSE_BROWSE_TILESET_LIBRARY_TOOL_NAME,
    {
      title: 'Browse the tile-intel tileset library (Phase 8H-3)',
      description: PROPOSE_BROWSE_TILESET_LIBRARY_DESCRIPTION,
      inputSchema: proposeBrowseTilesetLibraryInputShape,
    },
    async (args) => textResult(await proposeBrowseTilesetLibrary(ctx, args)),
  );

  server.registerTool(
    PROPOSE_APPLY_TEMPLATE_TOOL_NAME,
    {
      title: 'Place a mined map template at an anchor (Phase 8H-4)',
      description: PROPOSE_APPLY_TEMPLATE_DESCRIPTION,
      inputSchema: proposeApplyTemplateInputShape,
    },
    async (args) => textResult(await proposeApplyTemplate(ctx, args)),
  );

  server.registerTool(
    PROPOSE_CHECK_STORY_COHERENCE_TOOL_NAME,
    {
      title: 'Check story spec coherence (Phase 3.23)',
      description: PROPOSE_CHECK_STORY_COHERENCE_DESCRIPTION,
      inputSchema: proposeCheckStoryCoherenceInputShape,
    },
    async (args) => textResult(await proposeCheckStoryCoherence(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_REGION_MAP_LABEL_TOOL_NAME,
    {
      title: 'Set region-map label (Phase 3.29)',
      description: PROPOSE_SET_REGION_MAP_LABEL_DESCRIPTION,
      inputSchema: proposeSetRegionMapLabelInputShape,
    },
    async (args) => textResult(await proposeSetRegionMapLabel(ctx, args)),
  );

  server.registerTool(
    PROPOSE_EDIT_EVOLUTION_TOOL_NAME,
    {
      title: 'Edit species evolutions (Phase 3.28)',
      description: PROPOSE_EDIT_EVOLUTION_DESCRIPTION,
      inputSchema: proposeEditEvolutionInputShape,
    },
    async (args) => textResult(await proposeEditEvolution(ctx, args)),
  );

  server.registerTool(
    PROPOSE_GENERATE_README_TOOL_NAME,
    {
      title: 'Generate hack README (Phase 3.39)',
      description: PROPOSE_GENERATE_README_DESCRIPTION,
      inputSchema: proposeGenerateReadmeInputShape,
    },
    async (args) => textResult(await proposeGenerateReadme(ctx, args)),
  );

  server.registerTool(
    PROPOSE_IMPORT_OVERWORLD_SPRITE_TOOL_NAME,
    {
      title: 'Import an overworld sprite (Phase 3.14)',
      description: PROPOSE_IMPORT_OVERWORLD_SPRITE_DESCRIPTION,
      inputSchema: proposeImportOverworldSpriteInputShape,
    },
    async (args) => textResult(await proposeImportOverworldSprite(ctx, args)),
  );

  server.registerTool(
    PROPOSE_IMPORT_TILESET_TOOL_NAME,
    {
      title: 'Import a tileset (Phase 3.13)',
      description: PROPOSE_IMPORT_TILESET_DESCRIPTION,
      inputSchema: proposeImportTilesetInputShape,
    },
    async (args) => textResult(await proposeImportTileset(ctx, args)),
  );

  server.registerTool(
    PROPOSE_CUTSCENE_TOOL_NAME,
    {
      title: 'Compose a choreographed cutscene (Phase 3.20)',
      description: PROPOSE_CUTSCENE_DESCRIPTION,
      inputSchema: proposeCutsceneInputShape,
    },
    async (args) => textResult(await proposeCutscene(ctx, args)),
  );

  server.registerTool(
    PROPOSE_IMPORT_TRAINER_SPRITE_TOOL_NAME,
    {
      title: 'Import a trainer battle-front sprite (Phase 3.15)',
      description: PROPOSE_IMPORT_TRAINER_SPRITE_DESCRIPTION,
      inputSchema: proposeImportTrainerSpriteInputShape,
    },
    async (args) => textResult(await proposeImportTrainerSprite(ctx, args)),
  );

  server.registerTool(
    PROPOSE_IMPORT_PORTRAIT_TOOL_NAME,
    {
      title: 'Import a 32×32 portrait (Phase 3.16)',
      description: PROPOSE_IMPORT_PORTRAIT_DESCRIPTION,
      inputSchema: proposeImportPortraitInputShape,
    },
    async (args) => textResult(await proposeImportPortrait(ctx, args)),
  );

  server.registerTool(
    PROPOSE_IMPORT_POKEMON_SPRITE_TOOL_NAME,
    {
      title: 'Import a Pokémon battle sprite (Phase 3.17)',
      description: PROPOSE_IMPORT_POKEMON_SPRITE_DESCRIPTION,
      inputSchema: proposeImportPokemonSpriteInputShape,
    },
    async (args) => textResult(await proposeImportPokemonSprite(ctx, args)),
  );

  server.registerTool(
    PROPOSE_BATCH_APPLY_TOOL_NAME,
    {
      title: 'Transactional batch apply (Phase 3.26)',
      description: PROPOSE_BATCH_APPLY_DESCRIPTION,
      inputSchema: proposeBatchApplyInputShape,
    },
    async (args) => textResult(await proposeBatchApply(ctx, args)),
  );

  server.registerTool(
    PROPOSE_TEST_SCENE_TOOL_NAME,
    {
      title: 'Simulate a scene without the emulator (Phase 3.25)',
      description: PROPOSE_TEST_SCENE_DESCRIPTION,
      inputSchema: proposeTestSceneInputShape,
    },
    async (args) => textResult(await proposeTestScene(ctx, args)),
  );

  server.registerTool(
    PROPOSE_AUTHOR_SCENE_TOOL_NAME,
    {
      title: 'Plan a complete scene (Phase 3.24)',
      description: PROPOSE_AUTHOR_SCENE_DESCRIPTION,
      inputSchema: proposeAuthorSceneInputShape,
    },
    async (args) => textResult(await proposeAuthorScene(ctx, args)),
  );

  server.registerTool(
    PROPOSE_POKEDEX_ENTRY_TOOL_NAME,
    {
      title: 'Set Pokédex entry + flavor text (Phase 3.42)',
      description: PROPOSE_POKEDEX_ENTRY_DESCRIPTION,
      inputSchema: proposePokedexEntryInputShape,
    },
    async (args) => textResult(await proposePokedexEntry(ctx, args)),
  );

  server.registerTool(
    PROPOSE_ADD_SPECIES_TOOL_NAME,
    {
      title: 'Plan adding a new species (Phase 3.43)',
      description: PROPOSE_ADD_SPECIES_DESCRIPTION,
      inputSchema: proposeAddSpeciesInputShape,
    },
    async (args) => textResult(await proposeAddSpecies(ctx, args)),
  );

  server.registerTool(
    PROPOSE_EDIT_ABILITY_TOOL_NAME,
    {
      title: 'Edit/register an ability effect (Phase 3.31)',
      description: PROPOSE_EDIT_ABILITY_DESCRIPTION,
      inputSchema: proposeEditAbilityInputShape,
    },
    async (args) => textResult(await proposeEditAbility(ctx, args)),
  );

  server.registerTool(
    PROPOSE_EDIT_CREDITS_TOOL_NAME,
    {
      title: 'Edit hack credits roll (Phase 3.34)',
      description: PROPOSE_EDIT_CREDITS_DESCRIPTION,
      inputSchema: proposeEditCreditsInputShape,
    },
    async (args) => textResult(await proposeEditCredits(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_FLY_DESTINATION_TOOL_NAME,
    {
      title: 'Set fly / heal-location destination (Phase 3.30)',
      description: PROPOSE_SET_FLY_DESTINATION_DESCRIPTION,
      inputSchema: proposeSetFlyDestinationInputShape,
    },
    async (args) => textResult(await proposeSetFlyDestination(ctx, args)),
  );

  server.registerTool(
    PROPOSE_IMPORT_MUSIC_TOOL_NAME,
    {
      title: 'Import a custom music track via mid2agb (Phase 3.36)',
      description: PROPOSE_IMPORT_MUSIC_DESCRIPTION,
      inputSchema: proposeImportMusicInputShape,
    },
    async (args) => textResult(await proposeImportMusic(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_SOUND_EFFECT_TOOL_NAME,
    {
      title: 'Import a sound effect from WAV (Phase 3.37)',
      description: PROPOSE_SET_SOUND_EFFECT_DESCRIPTION,
      inputSchema: proposeSetSoundEffectInputShape,
    },
    async (args) => textResult(await proposeSetSoundEffect(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_CRY_TOOL_NAME,
    {
      title: 'Import a Pokémon cry from WAV (Phase 3.38)',
      description: PROPOSE_SET_CRY_DESCRIPTION,
      inputSchema: proposeSetCryInputShape,
    },
    async (args) => textResult(await proposeSetCry(ctx, args)),
  );

  server.registerTool(
    PROPOSE_TEST_PATCH_TOOL_NAME,
    {
      title: 'Test a distributed BPS patch (Phase 3.40)',
      description: PROPOSE_TEST_PATCH_DESCRIPTION,
      inputSchema: proposeTestPatchInputShape,
    },
    async (args) => textResult(await proposeTestPatch(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_TITLE_SCREEN_TOOL_NAME,
    {
      title: 'Set title screen logo/background (Phase 3.33)',
      description: PROPOSE_SET_TITLE_SCREEN_DESCRIPTION,
      inputSchema: proposeSetTitleScreenInputShape,
    },
    async (args) => textResult(await proposeSetTitleScreen(ctx, args)),
  );

  server.registerTool(
    PROPOSE_SET_BATTLE_UI_TOOL_NAME,
    {
      title: 'Set battle UI element (Phase 3.35)',
      description: PROPOSE_SET_BATTLE_UI_DESCRIPTION,
      inputSchema: proposeSetBattleUiInputShape,
    },
    async (args) => textResult(await proposeSetBattleUi(ctx, args)),
  );

  server.registerTool(
    PROPOSE_CREATE_TRAINER_CLASS_TOOL_NAME,
    {
      title: 'Set/create trainer class name (Phase 3.19)',
      description: PROPOSE_CREATE_TRAINER_CLASS_DESCRIPTION,
      inputSchema: proposeCreateTrainerClassInputShape,
    },
    async (args) => textResult(await proposeCreateTrainerClass(ctx, args)),
  );

  server.registerTool(
    PROPOSE_CREATE_ITEM_TOOL_NAME,
    {
      title: 'Create / set an item (Phase 3.32)',
      description: PROPOSE_CREATE_ITEM_DESCRIPTION,
      inputSchema: proposeCreateItemInputShape,
    },
    async (args) => textResult(await proposeCreateItem(ctx, args)),
  );

  server.registerTool(
    PROPOSE_EDIT_MART_TOOL_NAME,
    {
      title: 'Set a mart inventory (Phase 3.27)',
      description: PROPOSE_EDIT_MART_DESCRIPTION,
      inputSchema: proposeEditMartInputShape,
    },
    async (args) => textResult(await proposeEditMart(ctx, args)),
  );

  server.registerTool(
    READ_IMAGE_TOOL_NAME,
    {
      title: 'Read image (vision input)',
      description: READ_IMAGE_DESCRIPTION,
      inputSchema: readImageInputShape,
    },
    async (args) => {
      // Custom result shape: return the image as a vision-compatible
      // content block (when ok) so Claude can SEE the image in its
      // context. Errors fall back to text.
      const result = await readImage(ctx, args);
      if (result.ok && result.base64 && result.mimeType) {
        return {
          content: [
            {
              type: 'image' as const,
              data: result.base64,
              mimeType: result.mimeType,
            },
            {
              type: 'text' as const,
              text: `Image loaded: ${result.byteLength} bytes, ${result.mimeType}, source ${result.source}`,
            },
          ],
        };
      }
      return textResult({
        ok: false,
        reason: result.reason,
        message: result.message,
      });
    },
  );

  return server;
}

async function main(): Promise<void> {
  const projectRoot = process.env.ROM_EDITOR_PROJECT_ROOT;
  if (!projectRoot) {
    process.stderr.write(
      'rom-editor-agent: ROM_EDITOR_PROJECT_ROOT env var is required (absolute path to the open project).\n',
    );
    process.exit(2);
  }
  // Optional - only required for propose_patch and other tools that
  // need to push state into the Fastify backend.
  const baseUrl = process.env.ROM_EDITOR_BASE_URL || undefined;
  if (baseUrl && process.env.GBA_DESKTOP_SESSION_TOKEN) globalThis.fetch = createDesktopApiFetch(baseUrl, process.env.GBA_DESKTOP_SESSION_TOKEN, globalThis.fetch);


  const server = createAgentMcpServer({ projectRoot, baseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /agent[\\/]mcp-server\.(?:js|ts)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`rom-editor-agent: fatal: ${message}\n`);
    process.exit(1);
  });
}
