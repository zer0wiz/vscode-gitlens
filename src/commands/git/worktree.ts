import type { MessageItem } from 'vscode';
import { QuickInputButtons, Uri, window, workspace } from 'vscode';
import type { Config } from '../../config';
import type { Container } from '../../container';
import { PlusFeatures } from '../../features';
import { convertOpenFlagsToLocation, reveal } from '../../git/actions/worktree';
import {
	WorktreeCreateError,
	WorktreeCreateErrorReason,
	WorktreeDeleteError,
	WorktreeDeleteErrorReason,
} from '../../git/errors';
import type { GitReference } from '../../git/models/reference';
import { getNameWithoutRemote, getReferenceLabel, isRevisionReference } from '../../git/models/reference';
import type { Repository } from '../../git/models/repository';
import { GitWorktree } from '../../git/models/worktree';
import { showGenericErrorMessage } from '../../messages';
import type { QuickPickItemOfT } from '../../quickpicks/items/common';
import { createQuickPickSeparator } from '../../quickpicks/items/common';
import { Directive } from '../../quickpicks/items/directive';
import type { FlagsQuickPickItem } from '../../quickpicks/items/flags';
import { createFlagsQuickPickItem } from '../../quickpicks/items/flags';
import { configuration } from '../../system/configuration';
import { basename, isDescendant } from '../../system/path';
import { pluralize, truncateLeft } from '../../system/string';
import { openWorkspace, revealInFileExplorer } from '../../system/utils';
import type { ViewsWithRepositoryFolders } from '../../views/viewBase';
import type {
	AsyncStepResultGenerator,
	CustomStep,
	PartialStepState,
	QuickPickStep,
	StepGenerator,
	StepResultGenerator,
	StepSelection,
	StepState,
} from '../quickCommand';
import {
	canInputStepContinue,
	canPickStepContinue,
	canStepContinue,
	createConfirmStep,
	createCustomStep,
	createPickStep,
	endSteps,
	QuickCommand,
	StepResultBreak,
} from '../quickCommand';
import {
	appendReposToTitle,
	ensureAccessStep,
	inputBranchNameStep,
	pickBranchOrTagStep,
	pickRepositoryStep,
	pickWorktreesStep,
	pickWorktreeStep,
} from '../quickCommand.steps';

interface Context {
	repos: Repository[];
	associatedView: ViewsWithRepositoryFolders;
	defaultUri?: Uri;
	pickedRootFolder?: Uri;
	pickedSpecificFolder?: Uri;
	showTags: boolean;
	title: string;
	worktrees?: GitWorktree[];
}

type CreateConfirmationChoice = Uri | 'changeRoot' | 'chooseFolder';
type CreateFlags = '--force' | '-b' | '--detach' | '--direct';

interface CreateState {
	subcommand: 'create';
	repo: string | Repository;
	uri: Uri;
	reference?: GitReference;
	createBranch?: string;
	flags: CreateFlags[];

	reveal?: boolean;
}

type DeleteFlags = '--force';

interface DeleteState {
	subcommand: 'delete';
	repo: string | Repository;
	uris: Uri[];
	flags: DeleteFlags[];
}

type OpenFlags = '--add-to-workspace' | '--new-window' | '--reveal-explorer';

interface OpenState {
	subcommand: 'open';
	repo: string | Repository;
	uri: Uri;
	flags: OpenFlags[];

	openOnly?: boolean;
	overrides?: {
		confirmTitle?: string;
		confirmPlaceholder?: string;
	};
}

type State = CreateState | DeleteState | OpenState;
type WorktreeStepState<T extends State> = SomeNonNullable<StepState<T>, 'subcommand'>;
type CreateStepState<T extends CreateState = CreateState> = WorktreeStepState<ExcludeSome<T, 'repo', string>>;
type DeleteStepState<T extends DeleteState = DeleteState> = WorktreeStepState<ExcludeSome<T, 'repo', string>>;
type OpenStepState<T extends OpenState = OpenState> = WorktreeStepState<ExcludeSome<T, 'repo', string>>;

function assertStateStepRepository(
	state: PartialStepState<State>,
): asserts state is PartialStepState<State> & { repo: Repository } {
	if (state.repo != null && typeof state.repo !== 'string') return;

	debugger;
	throw new Error('Missing repository');
}

const subcommandToTitleMap = new Map<State['subcommand'], string>([
	['create', 'Create'],
	['delete', 'Delete'],
	['open', 'Open'],
]);
function getTitle(title: string, subcommand: State['subcommand'] | undefined) {
	return subcommand == null ? title : `${subcommandToTitleMap.get(subcommand)} ${title}`;
}

export interface WorktreeGitCommandArgs {
	readonly command: 'worktree';
	confirm?: boolean;
	state?: Partial<State>;
}

export class WorktreeGitCommand extends QuickCommand<State> {
	private subcommand: State['subcommand'] | undefined;

	constructor(container: Container, args?: WorktreeGitCommandArgs) {
		super(container, 'worktree', 'worktree', 'Worktree', {
			description: 'open, create, or delete worktrees',
		});

		let counter = 0;
		if (args?.state?.subcommand != null) {
			counter++;

			switch (args.state.subcommand) {
				case 'create':
					if (args.state.uri != null) {
						counter++;
					}

					if (args.state.reference != null) {
						counter++;
					}

					break;
				case 'delete':
					if (args.state.uris != null && (!Array.isArray(args.state.uris) || args.state.uris.length !== 0)) {
						counter++;
					}

					break;
				case 'open':
					if (args.state.uri != null) {
						counter++;
					}

					break;
			}
		}

		if (args?.state?.repo != null) {
			counter++;
		}

		this.initialState = {
			counter: counter,
			confirm: args?.confirm,
			...args?.state,
		};
	}

	override get canConfirm(): boolean {
		return this.subcommand != null;
	}

	private _canSkipConfirmOverride: boolean | undefined;
	override get canSkipConfirm(): boolean {
		return this._canSkipConfirmOverride ?? false;
	}

	override get skipConfirmKey() {
		return `${this.key}${this.subcommand == null ? '' : `-${this.subcommand}`}:${this.pickedVia}`;
	}

	protected async *steps(state: PartialStepState<State>): StepGenerator {
		const context: Context = {
			repos: this.container.git.openRepositories,
			associatedView: this.container.worktreesView,
			showTags: false,
			title: this.title,
		};

		let skippedStepTwo = false;

		while (this.canStepsContinue(state)) {
			context.title = this.title;

			if (state.counter < 1 || state.subcommand == null) {
				this.subcommand = undefined;

				const result = yield* this.pickSubcommandStep(state);
				// Always break on the first step (so we will go back)
				if (result === StepResultBreak) break;

				state.subcommand = result;
			}

			this.subcommand = state.subcommand;

			if (state.counter < 2 || state.repo == null || typeof state.repo === 'string') {
				skippedStepTwo = false;
				if (context.repos.length === 1) {
					skippedStepTwo = true;
					if (state.repo == null) {
						state.counter++;
					}

					state.repo = context.repos[0];
				} else {
					const result = yield* pickRepositoryStep(state, context);
					if (result === StepResultBreak) continue;

					state.repo = result;
				}
			}

			// Ensure we use the "main" repository if we are in a worktree already
			state.repo = (await state.repo.getMainRepository()) ?? state.repo;
			assertStateStepRepository(state);

			const result = yield* ensureAccessStep(state, context, PlusFeatures.Worktrees);
			if (result === StepResultBreak) break;

			context.title = getTitle(state.subcommand === 'delete' ? 'Worktrees' : this.title, state.subcommand);

			switch (state.subcommand) {
				case 'create': {
					yield* this.createCommandSteps(state as CreateStepState, context);
					// Clear any chosen path, since we are exiting this subcommand
					state.uri = undefined;
					break;
				}
				case 'delete': {
					if (state.uris != null && !Array.isArray(state.uris)) {
						state.uris = [state.uris];
					}

					yield* this.deleteCommandSteps(state as DeleteStepState, context);
					break;
				}
				case 'open': {
					yield* this.openCommandSteps(state as OpenStepState, context);
					break;
				}
				default:
					endSteps(state);
					break;
			}

			// If we skipped the previous step, make sure we back up past it
			if (skippedStepTwo) {
				state.counter--;
			}
		}

		return state.counter < 0 ? StepResultBreak : undefined;
	}

	private *pickSubcommandStep(state: PartialStepState<State>): StepResultGenerator<State['subcommand']> {
		const step = createPickStep<QuickPickItemOfT<State['subcommand']>>({
			title: this.title,
			placeholder: `Choose a ${this.label} command`,
			items: [
				{
					label: 'open',
					description: 'opens the specified worktree',
					picked: state.subcommand === 'open',
					item: 'open',
				},
				{
					label: 'create',
					description: 'creates a new worktree',
					picked: state.subcommand === 'create',
					item: 'create',
				},
				{
					label: 'delete',
					description: 'deletes the specified worktrees',
					picked: state.subcommand === 'delete',
					item: 'delete',
				},
			],
			buttons: [QuickInputButtons.Back],
		});
		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}

	private async *createCommandSteps(state: CreateStepState, context: Context): AsyncStepResultGenerator<void> {
		if (context.defaultUri == null) {
			context.defaultUri = await state.repo.getWorktreesDefaultUri();
		}

		if (state.flags == null) {
			state.flags = [];
		}

		context.pickedRootFolder = undefined;
		context.pickedSpecificFolder = undefined;

		// Don't allow skipping the confirm step
		state.confirm = true;
		this._canSkipConfirmOverride = undefined;

		while (this.canStepsContinue(state)) {
			if (state.counter < 3 || state.reference == null) {
				const result = yield* pickBranchOrTagStep(state, context, {
					placeholder: context =>
						`Choose a branch${context.showTags ? ' or tag' : ''} to create the new worktree for`,
					picked: state.reference?.ref ?? (await state.repo.getBranch())?.ref,
					titleContext: ' for',
					value: isRevisionReference(state.reference) ? state.reference.ref : undefined,
				});
				// Always break on the first step (so we will go back)
				if (result === StepResultBreak) break;

				state.reference = result;
			}

			if (state.uri == null) {
				state.uri = context.defaultUri!;
			}

			if (this.confirm(state.confirm)) {
				const result = yield* this.createCommandConfirmStep(state, context);
				if (result === StepResultBreak) continue;

				if (typeof result[0] === 'string') {
					switch (result[0]) {
						case 'changeRoot': {
							const result = yield* this.createCommandChoosePathStep(state, context, {
								title: `Choose a Different Root Folder for this Worktree`,
								label: 'Choose Root Folder',
								pickedUri: context.pickedRootFolder,
								defaultUri: context.pickedRootFolder ?? context.defaultUri,
							});
							if (result === StepResultBreak) continue;

							state.uri = result;
							// Keep track of the actual uri they picked, because we will modify it in later steps
							context.pickedRootFolder = state.uri;
							context.pickedSpecificFolder = undefined;
							continue;
						}
						case 'chooseFolder': {
							const result = yield* this.createCommandChoosePathStep(state, context, {
								title: `Choose a Specific Folder for this Worktree`,
								label: 'Choose Worktree Folder',
								pickedUri: context.pickedRootFolder,
								defaultUri: context.pickedSpecificFolder ?? context.defaultUri,
							});
							if (result === StepResultBreak) continue;

							state.uri = result;
							// Keep track of the actual uri they picked, because we will modify it in later steps
							context.pickedRootFolder = undefined;
							context.pickedSpecificFolder = state.uri;
							continue;
						}
					}
				}

				[state.uri, state.flags] = result;
			}

			// Reset any confirmation overrides
			state.confirm = true;
			this._canSkipConfirmOverride = undefined;

			const isRemoteBranch = state.reference?.refType === 'branch' && state.reference?.remote;
			if (isRemoteBranch && !state.flags.includes('-b')) {
				state.flags.push('-b');

				state.createBranch = getNameWithoutRemote(state.reference);
				const branch = await state.repo.getBranch(state.createBranch);
				if (branch != null) {
					state.createBranch = state.reference.name;
				}
			}

			if (state.flags.includes('-b')) {
				let createBranchOverride: string | undefined;
				if (state.createBranch != null) {
					let valid = await this.container.git.validateBranchOrTagName(state.repo.path, state.createBranch);
					if (valid) {
						const alreadyExists = await state.repo.getBranch(state.createBranch);
						valid = alreadyExists == null;
					}

					if (!valid) {
						createBranchOverride = state.createBranch;
						state.createBranch = undefined;
					}
				}

				if (state.createBranch == null) {
					const result = yield* inputBranchNameStep(state, context, {
						titleContext: ` and New Branch from ${getReferenceLabel(state.reference, {
							capitalize: true,
							icon: false,
							label: state.reference.refType !== 'branch',
						})}`,
						value: createBranchOverride ?? state.createBranch ?? getNameWithoutRemote(state.reference),
					});
					if (result === StepResultBreak) {
						// Clear the flags, since we can backup after the confirm step below (which is non-standard)
						state.flags = [];
						continue;
					}

					state.createBranch = result;
				}
			}

			const uri = state.flags.includes('--direct')
				? state.uri
				: Uri.joinPath(
						state.uri,
						...(state.createBranch ?? state.reference.name).replace(/\\/g, '/').split('/'),
				  );

			let worktree: GitWorktree | undefined;
			try {
				worktree = await state.repo.createWorktree(uri, {
					commitish: state.reference?.name,
					createBranch: state.flags.includes('-b') ? state.createBranch : undefined,
					detach: state.flags.includes('--detach'),
					force: state.flags.includes('--force'),
				});

				if (state.reveal !== false) {
					void reveal(undefined, {
						select: true,
						focus: true,
					});
				}
			} catch (ex) {
				if (
					WorktreeCreateError.is(ex, WorktreeCreateErrorReason.AlreadyCheckedOut) &&
					!state.flags.includes('--force')
				) {
					const createBranch: MessageItem = { title: 'Create New Branch' };
					const force: MessageItem = { title: 'Create Anyway' };
					const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
					const result = await window.showWarningMessage(
						`Unable to create the new worktree because ${getReferenceLabel(state.reference, {
							icon: false,
							quoted: true,
						})} is already checked out.\n\nWould you like to create a new branch for this worktree or forcibly create it anyway?`,
						{ modal: true },
						createBranch,
						force,
						cancel,
					);

					if (result === createBranch) {
						state.flags.push('-b');
						this._canSkipConfirmOverride = true;
						state.confirm = false;
						continue;
					}

					if (result === force) {
						state.flags.push('--force');
						this._canSkipConfirmOverride = true;
						state.confirm = false;
						continue;
					}
				} else if (WorktreeCreateError.is(ex, WorktreeCreateErrorReason.AlreadyExists)) {
					const confirm: MessageItem = { title: 'OK' };
					const openFolder: MessageItem = { title: 'Open Folder' };
					void window
						.showErrorMessage(
							`Unable to create a new worktree in '${GitWorktree.getFriendlyPath(
								uri,
							)}' because the folder already exists and is not empty.`,
							confirm,
							openFolder,
						)
						.then(result => {
							if (result === openFolder) {
								void revealInFileExplorer(uri);
							}
						});
				} else {
					void showGenericErrorMessage(
						`Unable to create a new worktree in '${GitWorktree.getFriendlyPath(uri)}.`,
					);
				}
			}

			endSteps(state);
			if (worktree == null) break;

			type OpenAction = Config['worktrees']['openAfterCreate'];
			const action: OpenAction = configuration.get('worktrees.openAfterCreate');
			if (action === 'never') break;

			if (action === 'prompt') {
				yield* this.openCommandSteps(
					{
						subcommand: 'open',
						repo: state.repo,
						uri: worktree.uri,
						counter: 3,
						confirm: true,
						openOnly: true,
					} as OpenStepState,
					context,
				);

				break;
			}

			queueMicrotask(() => {
				switch (action) {
					case 'always':
						openWorkspace(worktree!.uri, { location: 'currentWindow' });
						break;
					case 'alwaysNewWindow':
						openWorkspace(worktree!.uri, { location: 'newWindow' });
						break;
					case 'onlyWhenEmpty':
						openWorkspace(worktree!.uri, {
							location: workspace.workspaceFolders?.length ? 'currentWindow' : 'newWindow',
						});
						break;
				}
			});
		}
	}

	private async *createCommandChoosePathStep(
		state: CreateStepState,
		context: Context,
		options: { title: string; label: string; pickedUri: Uri | undefined; defaultUri?: Uri },
	): AsyncStepResultGenerator<Uri> {
		const step = createCustomStep<Uri>({
			show: async (_step: CustomStep<Uri>) => {
				const uris = await window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					defaultUri: options.pickedUri ?? state.uri ?? context.defaultUri,
					openLabel: options.label,
					title: options.title,
				});

				if (uris == null || uris.length === 0) return Directive.Back;

				return uris[0];
			},
		});

		const value: StepSelection<typeof step> = yield step;

		if (!canStepContinue(step, state, value) || !(await canInputStepContinue(step, state, value))) {
			return StepResultBreak;
		}

		return value;
	}

	private *createCommandConfirmStep(
		state: CreateStepState,
		context: Context,
	): StepResultGenerator<[CreateConfirmationChoice, CreateFlags[]]> {
		/**
		 * Here are the rules for creating the recommended path for the new worktree:
		 *
		 * If the user picks a folder outside the repo, it will be `<chosen-path>/<repo>.worktrees/<?branch>`
		 * If the user picks the repo folder, it will be `<repo>/../<repo>.worktrees/<?branch>`
		 * If the user picks a folder inside the repo, it will be `<repo>/../<repo>.worktrees/<?branch>`
		 */

		let createDirectlyInFolder = false;
		if (context.pickedSpecificFolder != null) {
			createDirectlyInFolder = true;
		}

		const pickedUri = context.pickedSpecificFolder ?? context.pickedRootFolder ?? state.uri;
		const pickedFriendlyPath = truncateLeft(GitWorktree.getFriendlyPath(pickedUri), 60);

		let recommendedRootUri;

		const repoUri = state.repo.uri;
		const trailer = `${basename(repoUri.path)}.worktrees`;

		if (repoUri.toString() !== pickedUri.toString()) {
			if (isDescendant(pickedUri, repoUri)) {
				recommendedRootUri = Uri.joinPath(repoUri, '..', trailer);
			} else if (basename(pickedUri.path) === trailer) {
				recommendedRootUri = pickedUri;
			} else {
				recommendedRootUri = Uri.joinPath(pickedUri, trailer);
			}
		} else {
			recommendedRootUri = Uri.joinPath(repoUri, '..', trailer);
			// Don't allow creating directly into the main worktree folder
			createDirectlyInFolder = false;
		}

		const branchName =
			state.createBranch ?? (state.reference != null ? getNameWithoutRemote(state.reference) : undefined);

		const recommendedFriendlyPath = `<root>/${truncateLeft(
			`${trailer}/${branchName?.replace(/\\/g, '/') ?? ''}`,
			65,
		)}`;
		const recommendedNewBranchFriendlyPath = `<root>/${trailer}/<new-branch-name>`;

		const isRemoteBranch = state.reference?.refType === 'branch' && state.reference?.remote;

		type StepType = FlagsQuickPickItem<CreateFlags, CreateConfirmationChoice>;

		const confirmations: StepType[] = [];
		if (!createDirectlyInFolder) {
			confirmations.push(
				createFlagsQuickPickItem<CreateFlags, Uri>(
					state.flags,
					[],
					{
						label: isRemoteBranch ? 'Create Local Branch and Worktree' : context.title,
						description: '',
						detail: `Will create worktree in $(folder) ${recommendedFriendlyPath}`,
					},
					recommendedRootUri,
				),
				createFlagsQuickPickItem<CreateFlags, Uri>(
					state.flags,
					['-b'],
					{
						label: isRemoteBranch
							? 'Create New Local Branch and Worktree'
							: 'Create New Branch and Worktree',
						description: '',
						detail: `Will create worktree in $(folder) ${recommendedNewBranchFriendlyPath}`,
					},
					recommendedRootUri,
				),
			);
		} else {
			confirmations.push(
				createFlagsQuickPickItem<CreateFlags, Uri>(
					state.flags,
					['--direct'],
					{
						label: isRemoteBranch ? 'Create Local Branch and Worktree' : context.title,
						description: '',
						detail: `Will create worktree directly in $(folder) ${truncateLeft(pickedFriendlyPath, 60)}`,
					},
					pickedUri,
				),
				createFlagsQuickPickItem<CreateFlags, Uri>(
					state.flags,
					['-b', '--direct'],
					{
						label: isRemoteBranch
							? 'Create New Local Branch and Worktree'
							: 'Create New Branch and Worktree',
						description: '',
						detail: `Will create worktree directly in $(folder) ${truncateLeft(pickedFriendlyPath, 60)}`,
					},
					pickedUri,
				),
			);
		}

		if (!createDirectlyInFolder) {
			confirmations.push(
				createQuickPickSeparator(),
				createFlagsQuickPickItem<CreateFlags, CreateConfirmationChoice>(
					[],
					[],
					{
						label: 'Change Root Folder...',
						description: `$(folder) ${truncateLeft(pickedFriendlyPath, 65)}`,
						picked: false,
					},
					'changeRoot',
				),
			);
		}

		confirmations.push(
			createFlagsQuickPickItem<CreateFlags, CreateConfirmationChoice>(
				[],
				[],
				{
					label: 'Choose a Specific Folder...',
					description: '',
					picked: false,
				},
				'chooseFolder',
			),
		);

		const step = createConfirmStep(
			appendReposToTitle(
				`Confirm ${context.title} \u2022 ${getReferenceLabel(state.reference, {
					icon: false,
					label: false,
				})}`,
				state,
				context,
			),
			confirmations,
			context,
		);
		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection)
			? [selection[0].context, selection[0].item]
			: StepResultBreak;
	}

	private async *deleteCommandSteps(state: DeleteStepState, context: Context): StepGenerator {
		context.worktrees = await state.repo.getWorktrees();

		if (state.flags == null) {
			state.flags = [];
		}

		while (this.canStepsContinue(state)) {
			if (state.counter < 3 || state.uris == null || state.uris.length === 0) {
				context.title = getTitle('Worktrees', state.subcommand);

				const result = yield* pickWorktreesStep(state, context, {
					filter: wt => !wt.main || !wt.opened, // Can't delete the main or opened worktree
					includeStatus: true,
					picked: state.uris?.map(uri => uri.toString()),
					placeholder: 'Choose worktrees to delete',
				});
				// Always break on the first step (so we will go back)
				if (result === StepResultBreak) break;

				state.uris = result.map(w => w.uri);
			}

			context.title = getTitle(pluralize('Worktree', state.uris.length, { only: true }), state.subcommand);

			const result = yield* this.deleteCommandConfirmStep(state, context);
			if (result === StepResultBreak) continue;

			state.flags = result;

			endSteps(state);

			for (const uri of state.uris) {
				let retry = false;
				do {
					retry = false;
					const force = state.flags.includes('--force');

					try {
						if (force) {
							const worktree = context.worktrees.find(wt => wt.uri.toString() === uri.toString());
							let status;
							try {
								status = await worktree?.getStatus();
							} catch {}

							if (status?.hasChanges ?? false) {
								const confirm: MessageItem = { title: 'Force Delete' };
								const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
								const result = await window.showWarningMessage(
									`The worktree in '${uri.fsPath}' has uncommitted changes.\n\nDeleting it will cause those changes to be FOREVER LOST.\nThis is IRREVERSIBLE!\n\nAre you sure you still want to delete it?`,
									{ modal: true },
									confirm,
									cancel,
								);

								if (result !== confirm) return;
							}
						}

						await state.repo.deleteWorktree(uri, { force: force });
					} catch (ex) {
						if (WorktreeDeleteError.is(ex)) {
							if (ex.reason === WorktreeDeleteErrorReason.MainWorkingTree) {
								void window.showErrorMessage('Unable to delete the main worktree');
							} else if (!force) {
								const confirm: MessageItem = { title: 'Force Delete' };
								const cancel: MessageItem = { title: 'Cancel', isCloseAffordance: true };
								const result = await window.showErrorMessage(
									ex.reason === WorktreeDeleteErrorReason.HasChanges
										? `Unable to delete worktree because there are UNCOMMITTED changes in '${uri.fsPath}'.\n\nForcibly deleting it will cause those changes to be FOREVER LOST.\nThis is IRREVERSIBLE!\n\nWould you like to forcibly delete it?`
										: `Unable to delete worktree in '${uri.fsPath}'.\n\nWould you like to try to forcibly delete it?`,
									{ modal: true },
									confirm,
									cancel,
								);

								if (result === confirm) {
									state.flags.push('--force');
									retry = true;
								}
							}
						} else {
							void showGenericErrorMessage(`Unable to delete worktree in '${uri.fsPath}.`);
						}
					}
				} while (retry);
			}
		}
	}

	private *deleteCommandConfirmStep(state: DeleteStepState, context: Context): StepResultGenerator<DeleteFlags[]> {
		const step: QuickPickStep<FlagsQuickPickItem<DeleteFlags>> = createConfirmStep(
			appendReposToTitle(`Confirm ${context.title}`, state, context),
			[
				createFlagsQuickPickItem<DeleteFlags>(state.flags, [], {
					label: context.title,
					detail: `Will delete ${pluralize('worktree', state.uris.length, {
						only: state.uris.length === 1,
					})}${state.uris.length === 1 ? ` in $(folder) ${GitWorktree.getFriendlyPath(state.uris[0])}` : ''}`,
				}),
				createFlagsQuickPickItem<DeleteFlags>(state.flags, ['--force'], {
					label: `Force ${context.title}`,
					description: 'including ANY UNCOMMITTED changes',
					detail: `Will forcibly delete ${pluralize('worktree', state.uris.length, {
						only: state.uris.length === 1,
					})} ${
						state.uris.length === 1 ? ` in $(folder) ${GitWorktree.getFriendlyPath(state.uris[0])}` : ''
					}`,
				}),
			],
			context,
		);

		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}

	private async *openCommandSteps(state: OpenStepState, context: Context): StepGenerator {
		context.worktrees = await state.repo.getWorktrees();

		if (state.flags == null) {
			state.flags = [];
		}

		while (this.canStepsContinue(state)) {
			if (state.counter < 3 || state.uri == null) {
				context.title = getTitle('Worktree', state.subcommand);

				const result = yield* pickWorktreeStep(state, context, {
					includeStatus: true,
					picked: state.uri?.toString(),
					placeholder: 'Choose worktree to open',
				});
				// Always break on the first step (so we will go back)
				if (result === StepResultBreak) break;

				state.uri = result.uri;
			}

			context.title = getTitle(`Worktree \u2022 ${truncateLeft(basename(state.uri.path), 40)}`, state.subcommand);

			const result = yield* this.openCommandConfirmStep(state, context);
			if (result === StepResultBreak) continue;

			state.flags = result;

			endSteps(state);

			const worktree = context.worktrees.find(wt => wt.uri.toString() === state.uri.toString());
			if (worktree == null) break;

			if (state.flags.includes('--reveal-explorer')) {
				void revealInFileExplorer(worktree.uri);
			} else {
				openWorkspace(worktree.uri, { location: convertOpenFlagsToLocation(state.flags) });
			}
		}
	}

	private *openCommandConfirmStep(state: OpenStepState, context: Context): StepResultGenerator<OpenFlags[]> {
		type StepType = FlagsQuickPickItem<OpenFlags>;

		const confirmations: StepType[] = [
			createFlagsQuickPickItem<OpenFlags>(state.flags, [], {
				label: 'Open Worktree',
				detail: 'Will open the worktree in the current window',
			}),
			createFlagsQuickPickItem<OpenFlags>(state.flags, ['--new-window'], {
				label: `Open Worktree in a New Window`,
				detail: 'Will open the worktree in a new window',
			}),
		];

		if (!state.openOnly) {
			confirmations.push(
				createFlagsQuickPickItem<OpenFlags>(state.flags, ['--add-to-workspace'], {
					label: `Add Worktree to Workspace`,
					detail: 'Will add the worktree into the current workspace',
				}),
				createFlagsQuickPickItem<OpenFlags>(state.flags, ['--reveal-explorer'], {
					label: `Reveal in File Explorer`,
					description: `$(folder) ${truncateLeft(GitWorktree.getFriendlyPath(state.uri), 40)}`,
					detail: 'Will open the worktree in the File Explorer',
				}),
			);
		}

		const step = createConfirmStep(
			appendReposToTitle(state.overrides?.confirmTitle ?? `Confirm ${context.title}`, state, context),
			confirmations,
			context,
			undefined,
			state.overrides?.confirmPlaceholder
				? { placeholder: state.overrides.confirmPlaceholder }
				: { placeholder: 'Confirm Open Worktree' },
		);

		const selection: StepSelection<typeof step> = yield step;
		return canPickStepContinue(step, state, selection) ? selection[0].item : StepResultBreak;
	}
}
