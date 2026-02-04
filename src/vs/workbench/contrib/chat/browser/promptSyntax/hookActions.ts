/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatViewId } from '../chat.js';
import { CHAT_CATEGORY, CHAT_CONFIG_MENU_ID } from '../actions/chatActions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { PromptsType } from '../../common/promptSyntax/promptTypes.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { URI } from '../../../../../base/common/uri.js';
import { formatHookCommandLabel, HOOK_TYPES, HookType } from '../../common/promptSyntax/hookSchema.js';
import { NEW_HOOK_COMMAND_ID } from './newPromptFileActions.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITextEditorSelection } from '../../../../../platform/editor/common/editor.js';
import { findHookCommandSelection } from './hookUtils.js';
import { getHookSourceFormatLabel, HookSourceFormat, isReadOnlyHookSource, parseHooksFromFile } from '../../common/promptSyntax/hookCompatibility.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';

/**
 * Action ID for the `Configure Hooks` action.
 */
const CONFIGURE_HOOKS_ACTION_ID = 'workbench.action.chat.configure.hooks';

interface IHookEntry {
	readonly hookType: HookType;
	readonly hookTypeLabel: string;
	/** The original hook type ID as it appears in the JSON file (for selection lookup) */
	readonly originalHookTypeId: string;
	readonly fileUri: URI;
	readonly filePath: string;
	readonly displayLabel: string;
	readonly commandFieldName: 'command' | 'bash' | 'powershell' | undefined;
	readonly index: number;
	/** The source format (Copilot, Claude) */
	readonly sourceFormat: HookSourceFormat;
	/** Whether this hook is from a read-only source (Claude settings) */
	readonly isReadOnly: boolean;
}

interface IHookQuickPickItem extends IQuickPickItem {
	readonly hookEntry?: IHookEntry;
	readonly commandId?: string;
}

class ManageHooksAction extends Action2 {
	constructor() {
		super({
			id: CONFIGURE_HOOKS_ACTION_ID,
			title: localize2('configure-hooks', "Configure Hooks..."),
			shortTitle: localize2('configure-hooks.short', "Hooks"),
			icon: Codicon.zap,
			f1: true,
			precondition: ChatContextKeys.enabled,
			category: CHAT_CATEGORY,
			menu: {
				id: CHAT_CONFIG_MENU_ID,
				when: ContextKeyExpr.and(ChatContextKeys.enabled, ContextKeyExpr.equals('view', ChatViewId)),
				order: 12,
				group: '1_level'
			}
		});
	}

	public override async run(
		accessor: ServicesAccessor,
	): Promise<void> {
		const promptsService = accessor.get(IPromptsService);
		const quickInputService = accessor.get(IQuickInputService);
		const fileService = accessor.get(IFileService);
		const labelService = accessor.get(ILabelService);
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const pathService = accessor.get(IPathService);

		// Get workspace root and user home for path resolution
		const workspaceFolder = workspaceService.getWorkspace().folders[0];
		const workspaceRootUri = workspaceFolder?.uri;
		const userHomeUri = await pathService.userHome();
		const userHome = userHomeUri.fsPath ?? userHomeUri.path;

		// Get all hook files
		const hookFiles = await promptsService.listPromptFiles(PromptsType.hook, CancellationToken.None);

		// Parse hook files to extract hook entries using format-aware parsing
		const hookEntries: IHookEntry[] = [];

		for (const hookFile of hookFiles) {
			try {
				const content = await fileService.readFile(hookFile.uri);
				const json = JSON.parse(content.value.toString());

				// Use format-aware parsing
				const { format, hooks } = parseHooksFromFile(hookFile.uri, json, workspaceRootUri, userHome);
				const isReadOnly = isReadOnlyHookSource(format);

				for (const [hookType, { hooks: commands, originalId }] of hooks) {
					const hookTypeMeta = HOOK_TYPES.find(h => h.id === hookType);
					if (!hookTypeMeta) {
						continue;
					}

					for (let i = 0; i < commands.length; i++) {
						const hookCommand = commands[i];
						const displayLabel = formatHookCommandLabel(hookCommand) || localize('commands.hook.emptyCommand', '(empty command)');
						hookEntries.push({
							hookType,
							hookTypeLabel: hookTypeMeta.label,
							originalHookTypeId: originalId,
							fileUri: hookFile.uri,
							filePath: labelService.getUriLabel(hookFile.uri, { relative: true }),
							displayLabel,
							commandFieldName: hookCommand.command !== undefined ? 'command' : hookCommand.bash !== undefined ? 'bash' : 'powershell',
							index: i,
							sourceFormat: format,
							isReadOnly
						});
					}
				}
			} catch {
				// Skip files that can't be parsed
			}
		}

		// Build quick pick items grouped by hook type
		const items: (IHookQuickPickItem | IQuickPickSeparator)[] = [];

		// Add "New Hook..." option at the top
		items.push({
			label: `$(plus) ${localize('commands.new-hook.label', 'Add new hook...')}`,
			commandId: NEW_HOOK_COMMAND_ID,
			alwaysShow: true
		});

		// Group entries by hook type
		const groupedByType = new Map<HookType, IHookEntry[]>();
		for (const entry of hookEntries) {
			const existing = groupedByType.get(entry.hookType) ?? [];
			existing.push(entry);
			groupedByType.set(entry.hookType, existing);
		}

		// Sort hook types by their position in HOOK_TYPES
		const sortedHookTypes = Array.from(groupedByType.keys()).sort((a, b) => {
			const indexA = HOOK_TYPES.findIndex(h => h.id === a);
			const indexB = HOOK_TYPES.findIndex(h => h.id === b);
			return indexA - indexB;
		});

		// Add entries grouped by hook type
		for (const hookTypeId of sortedHookTypes) {
			const entries = groupedByType.get(hookTypeId)!;
			const hookType = HOOK_TYPES.find(h => h.id === hookTypeId)!;

			items.push({
				type: 'separator',
				label: hookType.label
			});

			for (const entry of entries) {
				// Build description with source format indicator for read-only hooks
				let description = entry.filePath;
				if (entry.isReadOnly) {
					description = `$(lock) ${getHookSourceFormatLabel(entry.sourceFormat)} · ${description}`;
				}

				items.push({
					label: entry.displayLabel,
					description,
					hookEntry: entry
				});
			}
		}

		// Show empty state message if no hooks found
		if (hookEntries.length === 0) {
			items.push({
				type: 'separator',
				label: localize('noHooks', "No hooks configured")
			});
		}

		const selected = await quickInputService.pick(items, {
			placeHolder: localize('commands.hooks.placeholder', 'Select a hook to open or add a new hook'),
			title: localize('commands.hooks.title', 'Hooks')
		});

		if (selected) {
			if (selected.commandId) {
				await commandService.executeCommand(selected.commandId);
			} else if (selected.hookEntry) {
				const entry = selected.hookEntry;
				let selection: ITextEditorSelection | undefined;

				// Try to find the command field to highlight
				if (entry.commandFieldName) {
					try {
						const content = await fileService.readFile(entry.fileUri);
						selection = findHookCommandSelection(
							content.value.toString(),
							entry.originalHookTypeId,
							entry.index,
							entry.commandFieldName
						);
					} catch {
						// Ignore errors and just open without selection
					}
				}

				await editorService.openEditor({
					resource: entry.fileUri,
					options: {
						selection,
						pinned: false
					}
				});
			}
		}
	}
}

/**
 * Helper to register the `Manage Hooks` action.
 */
export function registerHookActions(): void {
	registerAction2(ManageHooksAction);
}
