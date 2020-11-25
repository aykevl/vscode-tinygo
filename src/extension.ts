import * as vscode from 'vscode';
import * as path from 'path';
import cp = require('child_process');
import fs = require('fs');
import util = require('util');

let statusbarItem: vscode.StatusBarItem;

let workspaceState: vscode.Memento;

// Supported target boards in the preview.
const devices = new Set([
	'arduino',
	'arduino-nano33',
	'microbit',
]);

export async function activate(context: vscode.ExtensionContext) {
	let targets: string[] | null;

	workspaceState = context.workspaceState;

	// Create the TinyGo status bar icon, indicating which target is currently
	// active. The priority 49 makes sure it's just to the right of the Go
	// extension.
	statusbarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
	statusbarItem.command = 'vscode-tinygo.selectTarget';
	updateStatusBar();

	updatePreviewStatus();

	context.subscriptions.push(vscode.commands.registerCommand('vscode-tinygo.showPreviewToSide', async (uri: vscode.Uri) => {
		const mkdir = util.promisify(fs.mkdir);
		const readFile = util.promisify(fs.readFile);
		const writeFile = util.promisify(fs.writeFile);

		if (uri.scheme != 'file') {
			vscode.window.showErrorMessage('Cannot preview non-local packages.');
			return;
		}
		// The full (absolute) path to the package this Go file is part of.
		let packageFullPath = path.dirname(uri.fsPath);

		if (!context.storagePath) {
			// TODO: handle this in a more graceful manner.
			vscode.window.showErrorMessage('Cannot show preview: no storage path defined.');
			return;
		}

		// Load the preview state.
		let previewState : any;
		let previewStatePath = path.join(context.storagePath, 'tinygo-preview.json');
		try {
			try {
				await mkdir(context.storagePath);
			} catch (err) {}
			let rawJSON = await readFile(previewStatePath);
			previewState = JSON.parse(rawJSON.toString());
		} catch (err) {
			// Could not load the file. Assume it doesn't exist and use the
			// default value.
		}

		// Create a new webview for the preview.
		const panel = vscode.window.createWebviewPanel(
			'vscode-tinygo',
			'TinyGo Preview',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
			},
		);
		const basePath = vscode.Uri.file(path.join(context.extensionPath, 'play', 'play.html'));
		const baseURL = panel.webview.asWebviewUri(basePath);
		panel.webview.html = getPreviewHTML(baseURL.toString());

		let watcher: vscode.FileSystemWatcher;
		let outputChannel: vscode.OutputChannel;

		// Listen for incoming messages from the webview.
		panel.webview.onDidReceiveMessage(
			async message => {
				switch (message.command) {
				case 'loaded':
					// We got the 'loaded' signal, which means the webview has
					// finished loading and is accepting messages.
					panel.webview.postMessage({
						command: 'start',
						state:   previewState,
						device:  getPreviewDevice(),
					})
				case 'ready':
					// Start building the current package and send the produced
					// WebAssembly file to the webview. Also start listening for
					// saved Go files, to redo the compilation and run the new
					// code in the WebView.
					let compiler = new Compiler(context, panel, packageFullPath, message.buildTags);
					compiler.compile();
					watcher = vscode.workspace.createFileSystemWatcher('**/*.go');
					let compiling = 0;
					watcher.onDidChange(async uri => {
						if (compiling) {
							// A previous compilation was already running.
							// Abort the process and restart.
							compiler.stop();
							compiler = new Compiler(context, panel, packageFullPath, message.buildTags);
						}
						compiling++;
						await compiler.compile();
						compiling--;
					})
					break;
				case 'log':
					// Log a message to a TinyGo specific output channel.
					if (!outputChannel) {
						outputChannel = vscode.window.createOutputChannel('TinyGo output');
					}
					outputChannel.appendLine(message.message);
					break;
				case 'save':
					// State was updated, save it to a file.
					let rawJSON = JSON.stringify(message.state, null, 4);
					await writeFile(previewStatePath, rawJSON);
				}
			},
			undefined,
			context.subscriptions
		);

		// Clean up the WebView once the tab is closed.
		panel.onDidDispose(() => {
			watcher.dispose();
			if (outputChannel) {
				outputChannel.dispose();
			}
		});
	}))

	// Register the command, _after_ the list of targets has been read. This
	// makes sure the user will never see an empty list.
	context.subscriptions.push(vscode.commands.registerCommand('vscode-tinygo.selectTarget', async () => {
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

		// Obtain information about this target (GOROOT, build tags).
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
		envVars.GOROOT = goroot ? goroot: undefined;
		envVars.GOFLAGS = buildTags ? "-tags="+(buildTags.split(' ').join(',')) : undefined;
		config.update('toolsEnvVars', envVars, vscode.ConfigurationTarget.Workspace);

		// Update status bar.
		context.workspaceState.update('tinygo-target', target);
		context.workspaceState.update('tinygo-buildTags', buildTags);
		updateStatusBar();
		updatePreviewStatus();

		// Move the just picked target to the top of the list.
		moveElementToFront(targets, target);

		// Save the history of recently used targets.
		let history = context.globalState.get<string[]>('history') || [];
		moveElementToFront(history, target);
		context.globalState.update('history', history);
	}));
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

// updatePreviewStatus sets whether the preview feature is enabled for Go files
// depending on the selected target.
function updatePreviewStatus() {
	let hasPreview = false;
	if (getPreviewDevice()) {
		hasPreview = true;
	}
	vscode.commands.executeCommand('setContext', 'tinygoHasPreview', hasPreview);
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

// getPreviewDevice returns a device (board) name based on the currently
// selected target, or an empty string if no target could be found.
function getPreviewDevice(): string {
	let target = workspaceState.get('tinygo-target', '');
	if (devices.has(target)) {
		return target;
	}

	let buildTags = workspaceState.get('tinygo-buildTags', '');
	if (!buildTags) {
		return '';
	}

	for (let tag of buildTags.split(' ')) {
		tag = tag.replace(/_/g, '-')
		if (devices.has(tag)) {
			return tag;
		}
	}
	return '';
}

// Create the HTML that will be used in the webview.
// Use a <base> tag so that relative URLs are correctly resolved.
function getPreviewHTML(baseURL: string): string {
	return `<html>
  <head>
    <meta charset="utf-8"/>
    <base href="${baseURL}"/>
    <link rel="stylesheet" href="play.css"/>
    <script src="wiring.js" defer></script>
    <script src="devices.js" defer></script>
    <script src="runner.js" defer></script>
    <script src="play.js" defer></script>
  </head>
  <body class="vscode">
    <svg id="viewport">
      <defs>
        <filter id="device-shadow">
          <feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#888c"/>
        </filter>
      </defs>
      <g class="objects"></g>
      <g class="wires"></g>
      <g class="overlays"></g>
    </svg>
    <div id="info" class="panel">
      <div class="topbar">
        <h2>Info</h2><a href class="tab selected" data-for="#info-devices">Devices</a><a href class="tab" data-for="#info-pins">Pins</a><a href class="tab" data-for="#info-properties">Properties</a>
      </div>
      <div id="info-devices" class="tabcontent selected">
      </div>
      <div id="info-pins" class="tabcontent">
      </div>
      <div id="info-properties" class="tabcontent">
      </div>
    </div>
    <div id="add-device">
      <!-- TODO: use codicon icons for better integration, see https://github.com/microsoft/vscode/issues/95199 -->
      <button title="Add Device">+</button>
      <div id="add-device-dropdown">
        <div class="device" data-type="ws2812">WS2812</div>
        <div class="device" data-type="led">LED</div>
        <div class="device" data-type="st7789">ST7789 240x240 display</div>
      </div>
    </div>
  </body>
</html>
`;
}

class Compiler {
	buildTags: string[];
	context: vscode.ExtensionContext;
	panel: vscode.WebviewPanel;
	importPath: string;
	process: cp.ChildProcess | undefined;
	promise: Promise<string[]> | undefined;

	constructor(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, importPath: string, buildTags: string[]) {
		this.context = context;
		this.panel = panel;
		this.importPath = importPath;
		this.buildTags = buildTags;
	}

	async compile() {
		if (!vscode.workspace.workspaceFolders)
			return;

		// Indicate to the webview that we're currently compiling code.
		this.panel.webview.postMessage({
			command: 'compiling',
		})

		const mkdir = util.promisify(fs.mkdir);
		const readFile = util.promisify(fs.readFile);

		let storagePath = this.context.storagePath || '/tmp';

		// Compile to WebAssembly.
		try {
			await mkdir(storagePath);
		} catch (err) {}
		const outputPath = path.join(storagePath, 'vscode-tinygo-build-' + (Math.random() * 1e12).toFixed() + '.wasm');
		this.promise = new Promise((resolve, reject) => {
			// Both -opt=1 and -no-debug improve compile time slightly.
			let process = cp.execFile('tinygo', ['build', '-o', outputPath, '-tags', this.buildTags.join(','), '-opt=1', '-no-debug'],
			{
				cwd: this.importPath,
			}, (error, stdout, stderr) => {
				if (error) {
					reject(error);
				} else {
					resolve([stdout, stderr]);
				}
			});
			this.process = process;
		});
		try {
			await this.promise;
		} catch (error) {
			// If this.process is set, it is an actual error. If not, the stop()
			// function has been called.
			if (this.process) {
				vscode.window.showErrorMessage(`Could not build package:\n` + error);
			}
			this.process = undefined;
			this.promise = undefined;
			return;
		}
		this.process = undefined;
		this.promise = undefined;

		// Read the resulting file.
		let binary = await readFile(outputPath);

		// Send the file to the webview for execution.
		this.panel.webview.postMessage({
			command: 'run',
			binary:   binary,
		})
	}

	stop() {
		if (this.process) {
			let process = this.process;
			this.process = undefined; // signal this abnormal exit is intended
			process.kill();
		}
	}
}
