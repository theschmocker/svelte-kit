import * as vite from 'vite';
import { get_aliases } from '../../core/utils.js';

/**
 * @typedef {import('rollup').RollupOutput} RollupOutput
 * @typedef {import('rollup').OutputChunk} OutputChunk
 * @typedef {import('rollup').OutputAsset} OutputAsset
 */

/**
 * Invokes Vite.
 * @param {import('vite').UserConfig} config
 */
export async function create_build(config) {
	const { output } = /** @type {RollupOutput} */ (
		await vite.build({ ...config, configFile: false })
	);

	const chunks = output.filter(
		/** @returns {output is OutputChunk} */ (output) => output.type === 'chunk'
	);

	const assets = output.filter(
		/** @returns {output is OutputAsset} */ (output) => output.type === 'asset'
	);

	return { chunks, assets };
}

/**
 * Adds transitive JS and CSS dependencies to the js and css inputs.
 * @param {string} file
 * @param {import('vite').Manifest} manifest
 * @param {Set<string>} css
 * @param {Set<string>} js
 */
export function find_deps(file, manifest, js, css) {
	const chunk = manifest[file];

	if (js.has(chunk.file)) return;
	js.add(chunk.file);

	if (chunk.css) {
		chunk.css.forEach((file) => css.add(file));
	}

	if (chunk.imports) {
		chunk.imports.forEach((file) => find_deps(file, manifest, js, css));
	}
}

/**
 * The Vite configuration that we use by default.
 * @param {{
 *   config: import('types').ValidatedConfig;
 *   input: Record<string, string>;
 *   ssr: boolean;
 *   outDir: string;
 * }} options
 * @return {import('vite').UserConfig}
 */
export const get_default_config = function ({ config, input, ssr, outDir }) {
	return {
		appType: 'custom',
		base: assets_base(config.kit),
		build: {
			cssCodeSplit: true,
			manifest: true,
			outDir,
			polyfillModulePreload: false,
			rollupOptions: {
				input,
				output: {
					format: 'esm',
					entryFileNames: ssr ? '[name].js' : '[name]-[hash].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]'
				},
				preserveEntrySignatures: 'strict'
			},
			ssr
		},
		// prevent Vite copying the contents of `config.kit.files.assets`,
		// if it happens to be 'public' instead of 'static'
		publicDir: false,
		resolve: {
			alias: get_aliases(config.kit)
		}
	};
};

/**
 * @param {import('types').ValidatedKitConfig} config
 * @returns {string}
 */
export function assets_base(config) {
	// TODO this is so that Vite's preloading works. Unfortunately, it fails
	// during `svelte-kit preview`, because we use a local asset path. This
	// may be fixed in Vite 3: https://github.com/vitejs/vite/issues/2009
	const { base, assets } = config.paths;
	return `${assets || base}/${config.appDir}/immutable/`;
}

/**
 * @param {import('vite').UserConfig} config
 */
export function remove_svelte_kit(config) {
	// TODO i feel like there's a more elegant way to do this
	// @ts-expect-error - it can't handle infinite type expansion
	config.plugins = (config.plugins || [])
		.flat(Infinity)
		.filter((plugin) => plugin.name !== 'vite-plugin-svelte-kit');
}
