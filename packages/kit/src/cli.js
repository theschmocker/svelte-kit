import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import colors from 'kleur';
import sade from 'sade';
import * as vite from 'vite';
import { load_config } from './core/config/index.js';
import { networkInterfaces, release } from 'os';
import { coalesce_to_error } from './utils/error.js';

/** @param {unknown} e */
function handle_error(e) {
	const error = coalesce_to_error(e);

	if (error.name === 'SyntaxError') throw error;

	console.error(colors.bold().red(`> ${error.message}`));
	if (error.stack) {
		console.error(colors.gray(error.stack.split('\n').slice(1).join('\n')));
	}

	process.exit(1);
}

/**
 * @param {number} port
 * @param {boolean} https
 * @param {string} base
 */
async function launch(port, https, base) {
	const { exec } = await import('child_process');
	let cmd = 'open';
	if (process.platform == 'win32') {
		cmd = 'start';
	} else if (process.platform == 'linux') {
		if (/microsoft/i.test(release())) {
			cmd = 'cmd.exe /c start';
		} else {
			cmd = 'xdg-open';
		}
	}
	exec(`${cmd} ${https ? 'https' : 'http'}://localhost:${port}${base}`);
}

const prog = sade('svelte-kit').version('__VERSION__');

prog
	.command('dev')
	.describe('Start a development server')
	.option('-p, --port', 'Port')
	.option('-o, --open', 'Open a browser tab')
	.option('--host', 'Host (only use this on trusted networks)')
	.option('--https', 'Use self-signed HTTPS certificate')
	.option('-H', 'no longer supported, use --https instead') // TODO remove for 1.0
	.action(async ({ port, host, https, open, H }) => {
		let first = true;
		let relaunching = false;
		let uid = 1;

		/** @type {() => Promise<void>} */
		let close;

		async function start() {
			const svelte_config = await load_config();
			const config = await get_vite_config(svelte_config);
			config.server = config.server || {};

			// optional config from command-line flags
			// these should take precedence, but not print conflict warnings
			if (host) {
				config.server.host = host;
			}

			// if https is already enabled then do nothing. it could be an object and we
			// don't want to overwrite with a boolean
			if (https && !config?.server?.https) {
				config.server.https = https;
			}

			if (port) {
				config.server.port = port;
			}

			const server = await vite.createServer(config);
			await server.listen(port);

			const address_info = /** @type {import('net').AddressInfo} */ (
				/** @type {import('http').Server} */ (server.httpServer).address()
			);

			const resolved_config = server.config;

			welcome({
				port: address_info.port,
				host: address_info.address,
				https: !!(https || resolved_config.server.https),
				open: first && (open || !!resolved_config.server.open),
				base: svelte_config.kit.paths.base,
				loose: resolved_config.server.fs.strict === false,
				allow: resolved_config.server.fs.allow
			});

			first = false;

			return server.close;
		}

		// TODO: we should probably replace this with something like vite-plugin-restart
		async function relaunch() {
			const id = uid;
			relaunching = true;

			try {
				await close();
				close = await start();

				if (id !== uid) relaunch();
			} catch (e) {
				const error = /** @type {Error} */ (e);

				console.error(colors.bold().red(`> ${error.message}`));
				if (error.stack) {
					console.error(colors.gray(error.stack.split('\n').slice(1).join('\n')));
				}
			}

			relaunching = false;
		}

		try {
			if (H) throw new Error('-H is no longer supported — use --https instead');

			process.env.NODE_ENV = process.env.NODE_ENV || 'development';

			close = await start();

			chokidar.watch('svelte.config.js', { ignoreInitial: true }).on('change', () => {
				if (relaunching) uid += 1;
				else relaunch();
			});
		} catch (error) {
			handle_error(error);
		}
	});

prog
	.command('build')
	.describe('Create a production build of your app')
	.option('--verbose', 'Log more stuff', false)
	.action(async ({ verbose }) => {
		try {
			process.env.NODE_ENV = process.env.NODE_ENV || 'production';
			process.env.VERBOSE = verbose;

			const svelte_config = await load_config();
			const vite_config = await get_vite_config(svelte_config);
			await vite.build(vite_config); // TODO when we get rid of config.kit.vite, this can just be vite.build()
		} catch (error) {
			handle_error(error);
		}
	});

prog
	.command('preview')
	.describe('Serve an already-built app')
	.option('-p, --port', 'Port', 3000)
	.option('-o, --open', 'Open a browser tab', false)
	.option('--host', 'Host (only use this on trusted networks)', 'localhost')
	.option('--https', 'Use self-signed HTTPS certificate', false)
	.option('-H', 'no longer supported, use --https instead') // TODO remove for 1.0
	.action(async ({ port, host, https, open, H }) => {
		try {
			if (H) throw new Error('-H is no longer supported — use --https instead');

			process.env.NODE_ENV = process.env.NODE_ENV || 'production';

			const svelte_config = await load_config();
			const vite_config = await get_vite_config(svelte_config);

			vite_config.preview = vite_config.preview || {};

			// optional config from command-line flags
			// these should take precedence, but not print conflict warnings
			if (host) vite_config.preview.host = host;
			if (https) vite_config.preview.https = https;
			if (port) vite_config.preview.port = port;

			const preview_server = await vite.preview(vite_config);

			welcome({ port, host, https, open, base: preview_server.config.base });
		} catch (error) {
			handle_error(error);
		}
	});

prog
	.command('package')
	.describe('Create a package')
	.option('-w, --watch', 'Rerun when files change', false)
	.action(async ({ watch }) => {
		try {
			const config = await load_config();
			const packaging = await import('./packaging/index.js');

			await (watch ? packaging.watch(config) : packaging.build(config));
		} catch (error) {
			handle_error(error);
		}
	});

prog
	.command('sync')
	.describe('Synchronise generated files')
	.action(async () => {
		if (!fs.existsSync('svelte.config.js')) {
			console.warn('Missing svelte.config.js — skipping');
			return;
		}

		try {
			const config = await load_config();
			const sync = await import('./core/sync/sync.js');
			sync.all(config);
		} catch (error) {
			handle_error(error);
		}
	});

prog.parse(process.argv, { unknown: (arg) => `Unknown option: ${arg}` });

/**
 * @param {{
 *   open: boolean;
 *   host: string;
 *   https: boolean;
 *   port: number;
 *   base: string;
 *   loose?: boolean;
 *   allow?: string[];
 *   cwd?: string;
 * }} param0
 */
function welcome({ port, host, https, open, base, loose, allow, cwd }) {
	if (open) launch(port, https, base);

	console.log(colors.bold().cyan(`\n  SvelteKit v${'__VERSION__'}\n`));

	const protocol = https ? 'https:' : 'http:';
	const exposed = typeof host !== 'undefined' && host !== 'localhost' && host !== '127.0.0.1';

	Object.values(networkInterfaces()).forEach((interfaces) => {
		if (!interfaces) return;
		interfaces.forEach((details) => {
			// @ts-ignore node18 returns a number
			if (details.family !== 'IPv4' && details.family !== 4) return;

			// prettier-ignore
			if (details.internal) {
				console.log(`  ${colors.gray('local:  ')} ${protocol}//${colors.bold(`localhost:${port}`)}`);
			} else {
				if (details.mac === '00:00:00:00:00:00') return;

				if (exposed) {
					console.log(`  ${colors.gray('network:')} ${protocol}//${colors.bold(`${details.address}:${port}`)}`);
					if (loose) {
						console.log(`\n  ${colors.yellow('Serving with vite.server.fs.strict: false. Note that all files on your machine will be accessible to anyone on your network.')}`);
					} else if (allow?.length && cwd) {
						console.log(`\n  ${colors.yellow('Note that all files in the following directories will be accessible to anyone on your network: ' + allow.map(a => path.relative(cwd, a)).join(', '))}`);
					}
				} else {
					console.log(`  ${colors.gray('network: not exposed')}`);
				}
			}
		});
	});

	if (!exposed) {
		console.log('\n  Use --host to expose server to other devices on this network');
	}

	console.log('\n');
}

/**
 * @param {import('types').ValidatedConfig} svelte_config
 * @return {Promise<import('vite').UserConfig>}
 */
export async function get_vite_config(svelte_config) {
	for (const file of ['vite.config.js', 'vite.config.mjs', 'vite.config.cjs']) {
		if (fs.existsSync(file)) {
			// TODO warn here if config.kit.vite was specified
			const module = await import(path.resolve(file));
			return {
				...module.default,
				configFile: false
			};
		}
	}

	const { sveltekit } = await import('./vite/index.js');

	// TODO: stop reading Vite config from SvelteKit config or move to CLI
	const vite_config = await svelte_config.kit.vite();
	vite_config.plugins = [...(vite_config.plugins || []), ...sveltekit()];
	return vite_config;
}
