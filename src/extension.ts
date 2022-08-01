import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import * as preview from './preview';

let statusbarItem: vscode.StatusBarItem;

let workspaceState: vscode.Memento;

export async function activate(context: vscode.ExtensionContext) {
	let targets: string[] | null;

	workspaceState = context.workspaceState;

	// Create the TinyGo status bar icon, indicating which target is currently
	// active. The priority 49 makes sure it's just to the right of the Go
	// extension.
	statusbarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
	statusbarItem.command = 'vscode-tinygo.selectTarget';
	updateStatusBar();

	// Add 'preview' button to appropriate source files.
	preview.updateStatus(context);
	context.subscriptions.push(vscode.commands.registerCommand('vscode-tinygo.showPreviewToSide', async (uri: vscode.Uri) => {
		preview.createNewPane(context, uri);
	}));

	// Make sure these 'preview' panels are restored when VS Code is closed and
	// then opened.
	vscode.window.registerWebviewPanelSerializer('vscode-tinygo.preview', new preview.PreviewSerializer(context));

	// Register the command, _after_ the list of targets has been read. This
	// makes sure the user will never see an empty list.
	let disposable = vscode.commands.registerCommand('vscode-tinygo.selectTarget', async () => {
		// Load targets (if not already loaded).
		if (!targets) {
			targets = await readTargetList(context);
		}
		if (!targets) {
			// Failed to load the list of targets.
			// An error message has already been shown by readTargetList.
			return;
		}

		// Pick a target from the list.
		const target = await vscode.window.showQuickPick(targets, {
			placeHolder: 'pick a target...',
		});
		if (!target) return;

		// Obtain information about this target (GOOS, GOARCH, GOROOT, build tags).
		let goos = '';
		let goarch = '';
		let goroot = '';
		let buildTags = '';
		if (target != '-') {
			try {
				const execFile = util.promisify(cp.execFile);
				const {stdout, stderr} = await execFile('tinygo', ['info', target]);
				stdout.trimRight().split('\n').forEach(line => {
					let colonPos = line.indexOf(':');
					if (colonPos < 0) return;
					let key = line.substr(0, colonPos).trim();
					let value = line.substr(colonPos+1).trim();
					if (key == 'cached GOROOT') {
						goroot = value;
					} else if (key == 'build tags') {
						buildTags = value;
					} else if (key == 'GOOS') {
						goos = value;
					} else if (key == 'GOARCH') {
						goarch = value;
					}
				})
			} catch(err) {
				vscode.window.showErrorMessage(`Could not run 'tinygo info ${target}':\n` + err);
				return;
			}

			// Check whether all properties have been found.
			if (!buildTags) {
				vscode.window.showErrorMessage(`Could not find build tags for ${target}.`);
				return;
			}
			if (!goroot) {
				// The 'cached GOROOT' property was added in TinyGo 0.15.
				vscode.window.showErrorMessage(`Could not find GOROOT variable for ${target}, perhaps you have an older TinyGo version?`);
				return;
			}
		}

		// Update the configuration in the current workspace.
		// This will automatically reload gopls.
		const config = vscode.workspace.getConfiguration('go', null);
		let envVars = config.get<NodeJS.Dict<string>>('toolsEnvVars', {});
		envVars.GOOS = goos ? goos: undefined;
		envVars.GOARCH = goarch ? goarch: undefined;
		envVars.GOROOT = goroot ? goroot: undefined;
		envVars.GOFLAGS = buildTags ? "-tags="+(buildTags.split(' ').join(',')) : undefined;
		config.update('toolsEnvVars', envVars, vscode.ConfigurationTarget.Workspace);

		// Update status bar.
		context.workspaceState.update('tinygo-target', target);
		updateStatusBar();
		preview.updateStatus(context);

		// Move the just picked target to the top of the list.
		moveElementToFront(targets, target);

		// Save the history of recently used targets.
		let history = context.globalState.get<string[]>('history') || [];
		moveElementToFront(history, target);
		context.globalState.update('history', history);
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {
	statusbarItem.dispose();
}

// updateStatusBar updates the TinyGo sign in the status bar with the currently
// selected target.
function updateStatusBar() {
	let target = workspaceState.get('tinygo-target', '-');
	if (target != '-') {
		statusbarItem.text = 'TinyGo: ' + target;
	} else {
		statusbarItem.text = 'TinyGo';
	}
	statusbarItem.show();
}

// Read the list of targets from a `tinygo targets` command, ordered by recently
// used. It will show an error message and return null when the command fails.
async function readTargetList(context: vscode.ExtensionContext): Promise<string[] | null> {
	const execFile = util.promisify(cp.execFile);

	// Read the list of targets from TinyGo.
	try {
		const {stdout, stderr} = await execFile('tinygo', ['targets']);
		var targets = stdout.trimRight().split('\n');
	} catch(err) {
		vscode.window.showErrorMessage('Could not list TinyGo targets:\n' + err);
		return null;
	}

	// Special target to revert to Go defaults.
	targets.unshift('-');

	// Sort targets by most recently used.
	let history = context.globalState.get<string[]>('history') || [];
	for (let i=history.length-1; i >= 0; i--) {
		if (targets.indexOf(history[i]) < 0)
			continue;
		moveElementToFront(targets, history[i]);
	}

	return targets;
}

// Look for the first occurence of the value in values and move it to the front
// of the array. If it doesn't exist, add it as a new value to the front of the
// array.
function moveElementToFront(values: string[], value: string) {
	let index = values.indexOf(value);
	if (index > -1) {
		// Remove the old value.
		values.splice(index, 1);
	}
	// Add new value to the front.
	values.unshift(value);
}
