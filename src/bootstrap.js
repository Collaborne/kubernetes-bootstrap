#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const pathIsInside = require('path-is-inside');
const assert = require('assert');
const mkdirp = require('mkdirp');
const walk = require('walk');
const mustache = require('mustache');
const yaml = require('js-yaml');
const deepMerge = require('deepmerge');

const log4js = require('log4js');
log4js.configure(process.env.LOG4JS_CONFIG || path.resolve(__dirname, 'log4js.json'));
const logger = log4js.getLogger('kubernetes-bootstrap');

const k8s = require('./kubernetes/k8s-client.js');
const authorizeK8s = require('./kubernetes/authorize-k8s.js');
const util = require('./util.js');

const userDir = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];

// XXX: yargs cannot handle -Dvar=value, so we preprocess the arguments and replace those with '--define', 'var=value'
const args = process.argv
	.slice(2)
	.map(arg => {
		const isShortcutDefine = arg.startsWith('-D') && arg.length > 2;
		return isShortcutDefine ? ['--define', arg.substring(2)] : [arg];
	})
	.reduce((result, processedArg) => result.concat(processedArg), []);
const argv = require('yargs')
	.boolean('authorize').describe('authorize', 'Inject suitable secrets for accessing AWS ECR into the cluster')
	.string('service-account').default('service-account', 'default')
	.string('template-directory').default('template-directory', 'templates').describe('template-directory', 'Base directory for templates')
	.string('deploy-settings').default('deploy-settings', 'deploy.yaml').describe('deploy-settings', 'Settings to use for processing the templates')
	.string('deploy-settings-overrides').default('deploy-settings-overrides', 'deploy.yaml.override').describe('deploy-settings-overrides', 'Additional settings to load')
	.boolean('disable-overrides').describe('disable-overrides', 'Do not apply deploy.yaml.override')
	.string('output-directory').default('output-directory', 'target').describe('output-directory', 'Directory in which procesed templates are written')
	.boolean('output-only').describe('output-only', 'Only produce the output files, but do not apply them to the cluster')
	.string('kubeconfig').default('kubeconfig', process.env.KUBECONFIG || path.resolve(userDir, '.kube/config')).describe('kubeconfig', 'Kubectl configuration file to use for connecting to the cluster')
	.string('content').default('context', undefined).describe('context', 'Context in the kubectl configuration to use')
	.array('exclude').default('exclude', []).alias('x', 'exclude').describe('exclude', 'Template module to exclude')
	.array('define').default('define', []).alias('D', 'define').describe('define', 'Define/Override a setting on the command-line')
	.array('include-kind').default('include-kind', []).describe('include-kind', 'Only include resources of the given kind')
	.string('default-strategy').default('default-strategy', 'legacy').describe('default-strategy', 'The default strategy to use for applying resources')
	.array('smart-patch-kind').default('smart-patch-kind', []).describe('smart-patch-kind', 'Use "patch" as smart strategy for the given kind')
	.coerce(['exclude', 'define'], value => {
		return typeof value === 'string' ? [value] : value;
	})
	.coerce(['template-directory', 'output-directory'], value => {
		const effectiveValue = Array.isArray(value) ? value[value.length - 1] : value;
		return path.normalize(effectiveValue);
	})
	.help()
	.strict()
	.parse(args);

function isNotFoundErr(err) {
	// For "normal" resources kubernetes seems to use 'NotFound', but for CRDs we get 'Not Found'.
	// Try to be lenient here and accept all these as indicators for "try creating it, then!"
	return err.reason === 'NotFound' || err.code === 404 || err.reason === 'Not Found';
}

/**
 * Ensure that the namespace for the environment exists.
 *
 * @param {Object} k8sClient the kubernetes client
 * @param {string} environment the environment name
 * @param {Object} [extraLabels] additional labels to apply to the namespace
 * @param {Object} [extraAnnotations] additional annotations to apply to the namespace
 * @return {Promise<Object>} a promise to the namespace resource
 */
async function ensureNamespace(k8sClient, environment, extraLabels = {}, extraAnnotations = {}) {
	const nsResource = k8sClient.namespace(environment);

	try {
		return await nsResource.get();
	} catch (err) {
		if (isNotFoundErr(err)) {
			// Create a new one
			const labels = Object.assign({}, extraLabels, {
				creator: 'bootstrap'
			});
			const annotations = Object.assign({}, extraAnnotations);
			const namespace = {
				apiVersion: 'v1',
				kind: 'Namespace',
				metadata: {
					annotations,
					labels,
				}
			};
			return nsResource.create(namespace);
		}

		// Different error, let it bubble out.
		throw err;
	}
}

function getLogName(resource) {
	return `${resource.apiVersion}.${resource.kind} ${resource.metadata.name}`;
}

function getK8sAccessor(k8sClient, apiVersion, kind, namespace) {
	try {
		const k8sGroup = k8sClient.group(apiVersion);

		let accessor;
		if (namespace) {
			const k8sNamespace = k8sGroup.ns(namespace);
			assert(Boolean(k8sNamespace));
			accessor = k8sNamespace[kind.toLowerCase()];
		} else {
			accessor = k8sGroup[kind.toLowerCase()];
		}

		return accessor;
	} catch (err) {
		throw new Error(`Cannot instantiate the API for ${apiVersion}.${kind}: ${err.message}`);
	}
}

function getK8sResource(k8sClient, apiVersion, kind, namespace, name) {
	const accessor = getK8sAccessor(k8sClient, apiVersion, kind, namespace);
	if (!accessor) {
		throw new Error(`Cannot find API for ${apiVersion}.${kind}`);
	}

	return accessor(name);
}

async function strategyFail(k8sClient, resource) {
	// A strategy that fails.
	// Right now that is not doing much really, as the execution logic will simply try the next strategy
	// before actually failing.
	throw new Error(`Explicitly failing ${getLogName(resource)}`);
}

async function strategySkip(k8sClient, resource) {
	// A strategy that simply returns "success!"
	// This can be used to silently ignore updates in some cases.
	return {status: `Skipping ${getLogName(resource)}`};
}

async function strategyUpdate(k8sClient, resource) {
	const k8sResource = getK8sResource(k8sClient, resource.apiVersion, resource.kind, resource.metadata.namespace, resource.metadata.name);

	let resourceVersion;
	if (resource.meta && resource.metadata.resourceVersion) {
		resourceVersion = resource.metadata.resourceVersion;
	} else {
		const knownResource = await k8sResource.get();
		resourceVersion = knownResource.metadata.resourceVersion;
	}

	const resourceVersionMetadata = {
		metadata: {
			resourceVersion: resourceVersion,
		},
	};

	return k8sResource.update(deepMerge.all([resource, resourceVersionMetadata]));
}

async function strategyPatch(k8sClient, resource) {
	const k8sResource = getK8sResource(k8sClient, resource.apiVersion, resource.kind, resource.metadata.namespace, resource.metadata.name);

	// PATCH may not work on all resources in all situations:
	// k8s 1.5: TPRs cannot be patched, and lead to a 500 error. An UPDATE tends to work in these cases.
	// k8s 1.10?+: CRDs cannot be patched with a strategic merge patch, and we'll get a 415 Unsupported Media Type. Switching to a regular merge patch should usually work.
	// The 500 error should be handled by adding 'update' to the strategy (or using 'smart'). For the CRD issue we can try with both types of patches here.
	try {
		return await k8sResource.patch(resource, 'application/strategic-merge-patch+json');
	} catch (err) {
		if (err.reason === 'UnsupportedMediaType') {
			return k8sResource.patch(resource, 'application/merge-patch+json');
		}

		throw err;
	}
}

function strategyCreate(k8sClient, resource) {
	const k8sResource = getK8sResource(k8sClient, resource.apiVersion, resource.kind, resource.metadata.namespace, resource.metadata.name);

	// We need to simulate '--save-config' here, otherwise changes cannot not be properly 'apply'-ed later.
	const saveConfigMetadata = {
		metadata: {
			annotations: {
				'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(resource),
			},
		},
	};
	return k8sResource.create(deepMerge(resource, saveConfigMetadata));
}

/** All resources that the smart strategy will default to patching rather than updating */
const SMART_PATCH_KINDS = ['v1.Service', 'v1.ConfigMap', 'v1.Secret'];
// Add the kinds specified on the command-line as well
// XXX: This is mostly for experimentation, we should still further tune the default configuration for this tool
//      and/or replace it with something else.
if (argv['smart-patch-kind']) {
	SMART_PATCH_KINDS.push(...argv['smart-patch-kind']);
}

/**
 * Smart strategy
 *
 * Ideally we want to replace the existing resource with whatever we rendered through the template.
 * If the resource doesn't yet exist, then that should be considered "just fine" and the resource needs
 * to be created instead.
 *
 * Updating resources may fail when the resource has immutable fields which are not part of the original specification,
 * for example a service will usually get a `clusterIP` assigned if it didn't provide any. Any future update for these
 * must then provide this value, or use a PATCH approach -- which has some problems with introducing "drift".
 */
async function strategySmart(k8sClient, resource, flags) {
	const matchKind = `${resource.apiVersion}.${resource.kind}`;

	// Check the type, and decide whether to assume patching or updating.
	// In either case if things fail and the resource doesn't exist try to create it.
	const strategy = SMART_PATCH_KINDS.includes(matchKind) || flags.UPDATE_ALLOWED === false ? strategyPatch : strategyUpdate;
	try {
		return await strategy(k8sClient, resource);
	} catch (err) {
		if (!isNotFoundErr(err)) {
			throw err;
		}

		return strategyCreate(k8sClient, resource);
	}
}

/**
 * Legacy strategy for applying resources
 *
 * Historically we tried to first PATCH the resource, but that lead to a couple of ugly problems, such as the
 * inability to actually remove environment variables etc. After a while the target environment will invariably start
 * to drift away from the intended/documented state in the templates.
 * A annotation bootstrap.k8s.collaborne.com/ignore-patch-failures (with a "true" value) is used to decide whether
 * a patch failure would actually be considered a problem, further increasing the "weirdness"/"drifting" chance for the environment.
 *
 * This function contains the complete legacy implementation, which roughly translates to a 'patch,update,create'.
 */
async function strategyLegacy(k8sClient, resource, flags) {
	const k8sResource = getK8sResource(k8sClient, resource.apiVersion, resource.kind, resource.metadata.namespace, resource.metadata.name);

	/** The last attempted operation */
	let op;

	/** The result of that operation */
	let result;
	try {
		// First try patching, then replacing, and and fall back to creation if the object doesn't exist.
		// If REPLACE fails we could try do a DELETE+CREATE, but that may lead to interesting state problems
		// for controllers/operators monitoring that resource. In particular we mustn't do that for jobs, where the whole idea
		// is that they run once to completion.
		try {
			op = 'PATCH';
			result = await k8sResource.patch(resource);
		} catch (err) {
			// XXX: what would be the correct 'err.reason'?
			if (err.code === 405 && flags.UPDATE_ALLOWED) {
				// Cannot patch, try replace
				op = 'UPDATE';
				result = await k8sResource.update(resource);
			} else if (err.code === 500 && flags.UPDATE_ALLOWED) {
				// Error on the server side, try replace.
				// This seems to happen with ThirdPartyResources in 1.5:
				// May 29 08:41:14 minikube localkube[24061]: E0529 08:41:14.784327   24061 errors.go:63] apiserver received an error that is not an unversioned.Status: unable to find api field in struct ThirdPartyResourceData for the json field "spec"
				logger.warn(`Received ${err.status}: ${err.message}, trying to replace the object`);
				op = 'UPDATE';
				result = await k8sResource.update(resource);
			} else if (isNotFoundErr(err)) {
				// Non-existing resource, try creating
				// We need to simulate '--save-config' here, otherwise changes will not be properly applied later.
				const saveConfigMetadata = {
					metadata: {
						annotations: {
							'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify(resource)
						}
					}
				};
				op = 'CREATE';
				result = await k8sResource.create(deepMerge(resource, saveConfigMetadata));
			} else {
				// Otherwise: Throw the error further.
				throw err;
			}
		}

		logger.debug(`${op} ${getLogName(resource)}: ${JSON.stringify(result.status)}`);
		return result;
	} catch (err) {
		throw new Error(`Cannot apply resource ${getLogName(resource)}: ${err.message} (attempted ${op})`);
	}
}

/**
 * All known strategies
 *
 * @type {Object.<string, (k8sClient: any, resource: any, flags?: Flags) => Promise<any>>}
 */
const STRATEGIES = {
	fail: strategyFail,
	skip: strategySkip,

	create: strategyCreate,
	patch: strategyPatch,
	update: strategyUpdate,

	legacy: strategyLegacy,
	smart: strategySmart,
};

/**
 * Parse and validate a strategy reference
 *
 * @param {string} value the annotation value
 * @return {string[]} the parsed strategy
 */
function parseStrategyAnnotation(value) {
	// Value is a comma-delimited list of update approaches.
	// Each approach is tried, and if it works the resource is considered "updated".
	// The value "skip" and "fail" can be used to explicitly skip or fail the update.
	// The value "smart" can be used to select the default-for-this-resource-kind, which is the default.
	// The value "legacy" can used to use the legacy approach
	const strategies = value.split(',');
	const unknownStrategies = strategies.filter(strategy => !STRATEGIES[strategy]);
	if (unknownStrategies.length > 0) {
		// Any invalid value invalidates everything, we're not selective here!
		throw new Error(`Unrecognized strategies '${unknownStrategies}'`);
	}
	return strategies;
}

/**
 * @typedef {Object} Flags
 * @property {boolean} MANUAL_ONLY
 * @property {string[]} STRATEGY
 * @property {boolean} UPDATE_ALLOWED
 */

/**
 * Parse the annotations into flags
 *
 * @param {Object.<string, string>} annotations annotations on a resource
 * @return {Flags} the found flags
 */
function getApplyFlags(annotations) {
	// Process all annotations into flags.
	// If there are annotations for this tool that we do not know: Immediately abort, as these
	// annotations may require a behavior that we simply do not provide.
	const group = 'bootstrap.k8s.collaborne.com';

	const flags = {
		MANUAL_ONLY: false,
		STRATEGY: parseStrategyAnnotation(argv.defaultStrategy ? String(argv.defaultStrategy) : ''),
		UPDATE_ALLOWED: true,
	};
	let ignorePatchFailures = false;
	for (const annotation of Object.keys(annotations)) {
		if (!annotation.startsWith(`${group}/`)) {
			// Irrelevant for us.
			continue;
		}
		const name = annotation.substring(annotation.indexOf('/') + 1);
		const value = annotations[annotation];
		switch (name) {
		case 'ignore-patch-failures':
			ignorePatchFailures = value === 'true';
			break;
		case 'manual':
			flags.MANUAL_ONLY = value === 'true';
			break;
		case 'strategy':
			flags.STRATEGY = parseStrategyAnnotation(value);
			break;
		case 'update-allowed':
			flags.UPDATE_ALLOWED = value === 'true';
			break;
		default:
			throw new Error(`Unrecognized annotation '${annotation}'`);
		}
	}

	// Sanity check the final flag values.
	// Note that 'manual' doesn't create an error, as manual serves the function to disable the whole automatism.
	if (!flags.UPDATE_ALLOWED && flags.STRATEGY.includes('update')) {
		throw new Error(`${group}/update-allowed cannot be 'false' when the strategy includes 'update'`);
	}

	if (ignorePatchFailures) {
		// Obsolete way to control the strategy: Allow skipping if this fail
		// Typical assumption is that the strategy is now set to ['smart'].
		logger.info('Using \'skip\' as last strategy');
		flags.STRATEGY.push('skip');
	}

	return flags;
}

/**
 * Apply the given resource into the current kubernetes context.
 *
 * @param {Object} k8sClient the kubernetes client to use for applying the resource
 * @param {Object} resource the resource
 * @return {Promise<Object>} a promise to the update result object
 */
async function applyResource(k8sClient, resource) {
	const flags = getApplyFlags(resource.metadata.annotations);

	if (flags.MANUAL_ONLY) {
		// Resource is not to be applied automatically, stop here.
		logger.info(`Skipping manual resource ${getLogName(resource)}`);
		return resource;
	}

	// Try to update the resource according to the strategy
	// We have three potential outcomes here:
	// 1. The strategy worked out, and the resource is now "updated"
	// 2. The strategy recognized that the resource is not in the right state
	// 3. The strategy failed completely for some other odd reason.
	// Right now we consider the cases 2 and 3 to be the same in effect, and in both cases we will try
	// the next strategy.
	let result;
	let success;
	for (const strategy of flags.STRATEGY) {
		try {
			const runStrategy = STRATEGIES[strategy];
			logger.debug(`${getLogName(resource)}: Trying ${strategy}`);
			result = await runStrategy(k8sClient, resource, flags);
			logger.debug(`${strategy.toUpperCase()} ${getLogName(resource)}: ${JSON.stringify(result.status)}`);
			success = true;
			break;
		} catch (err) {
			// Fine, try the next one then.
			logger.info(`${getLogName(resource)}: ${strategy} failed: ${err.message}`);
		}
	}

	// XXX: Can we check result.status here instead?
	if (!success) {
		// None of the strategies worked
		throw new Error(`Cannot apply resource ${getLogName(resource)} through '${flags.STRATEGY}'`);
	}
	return result;
}

/**
 * Function that processes a single resource
 *
 * @callback processCallback
 * @param {Object} resource the resource object to process
 * @return {Promise<Object>} a promise that resolves when the resource has been applied
 */

/**
 * @param {String} templatesDir
 * @param {Array<String>} modules
 * @param {String} outputDir,
 * @param {Object} properties
 * @param {processCallback} processResource function to call with a single resource
 */
function processTemplates(templatesDir, modules, outputDir, properties, processResource) {
	return new Promise(resolve => {
		const resourcePromises = [];
		const walker = walk.walk(templatesDir, {});
		let modulesFiltered = false;
		walker.on('directories', (root, dirStatsArray, next) => {
			// Remove top-level directories not in the modules array
			if (!modulesFiltered) {
				for (let i = dirStatsArray.length - 1; i >= 0; i--) {
					const dirStats = dirStatsArray[i];
					if (modules.indexOf(dirStats.name) === -1) {
						dirStatsArray.splice(i, 1);
					}
				}
				modulesFiltered = true;
			}
			return next();
		});
		walker.on('file', (root, fileStats, next) => {
			const ext = path.extname(fileStats.name);
			if (['.json', '.yml'].indexOf(ext) === -1) {
				// Skip unsupported files.
				return next();
			}
			const inputFileName = path.resolve(root, fileStats.name);
			return fs.readFile(inputFileName, (err, contents) => {
				if (err) {
					logger.error(`Cannot read ${inputFileName}: ${err.message}`);
					return next();
				}

				const relativeInputFileName = path.relative(templatesDir, inputFileName);
				const outputFileName = path.resolve(outputDir, relativeInputFileName);
				return mkdirp(path.dirname(outputFileName), mkdirpErr => {
					if (mkdirpErr) {
						logger.error(`Cannot create directory for ${outputFileName}: ${mkdirpErr.message}`);
						return next();
					}

					// Handle the case that we have a JSON file: read those, and produce contents as yaml.
					// Later on we need to parse the result anyways.
					let template;
					if (path.extname(inputFileName) === '.json') {
						template = yaml.safeDump(JSON.parse(contents.toString('UTF-8')));
					} else {
						template = contents.toString('UTF-8');
					}
					const renderedContents = mustache.render(template, properties, partial => {
						// Filters are functions that take a buffer-or-string, and produce a buffer-or-string
						// Generally it's good to stay "buffer-y" for a long time.
						const filterConstructors = {
							base64() {
								return value => {
									if (!Buffer.isBuffer(value)) {
										throw new Error('Buffer required for base64');
									}
									return value.toString('base64');
								};
							},

							indent(spaces = 2) {
								return value => {
									// Force utf8 now: indenting is a string operation.
									return value.toString('utf8').replace(/^.+/gm, `${' '.repeat(spaces)}$&`);
								};
							},

							newline() {
								// Force utf8 now: indenting is a string operation.
								return value => `${value.toString('utf8')}\n`;
							}
						};

						function parseFilterExpression(filterExpression) {
							let filterName;
							let filterArgs;
							const openIndex = filterExpression.indexOf('(');
							if (openIndex >= 0) {
								const closeIndex = filterExpression.indexOf(')', openIndex);
								filterArgs = filterExpression.substring(openIndex + 1, closeIndex).split(',').map(arg => arg.trim());
								filterName = filterExpression.substring(0, openIndex);
							} else {
								filterArgs = [];
								filterName = filterExpression;
							}
							const filterConstructor = filterConstructors[filterName];
							if (!filterConstructor) {
								throw new Error(`Cannot create filter '${filterExpression}': Unknown filter ${filterName}`);
							}
							return filterConstructor(...filterArgs);
						}

						// Syntax: partial is filename[|function[([param[,param]]][|...]]
						const tokens = partial.split(/\|/).map(token => token.trim());

						// First create the filters, and check that each of these are "happy"
						const filterExpressions = tokens.slice(1);
						const filters = filterExpressions.map(parseFilterExpression);

						// Now validate the file itself
						const fileName = tokens[0];
						if (fileName === '') {
							throw new Error(`Invalid partial ${partial}: Empty file name`);
						}
						// Interpret the name relative to directory containing the template itself
						const source = path.resolve(path.dirname(inputFileName), fileName);
						// Source must not leave root
						if (pathIsInside(root, source)) {
							throw new Error(`Invalid partial ${partial} (${source}): outside of ${root}`);
						}

						// Finally apply the filters in order
						const value = fs.readFileSync(source);
						return filters.reduce((result, filter) => filter(result), value);
					});
					return fs.writeFile(outputFileName, renderedContents, writeErr => {
						if (writeErr) {
							logger.error(`Cannot write ${outputFileName}: ${writeErr.message}`);
							return next();
						}

						// Push the file also into k8s now
						// There are two ways for producting multiple items in a single yaml file, either the root-object is a v1.List,
						// or the documents are concatenated using '---'
						renderedContents.split(/^---+$/m).filter(document => document.trim().length > 0).map(document => {
							try {
								const parsedContents = yaml.safeLoad(document);
								if (!parsedContents) {
									// Document (part) is empty, ignore it.
									return [];
								}

								if (parsedContents.kind === 'List') {
									return parsedContents.items;
								}
								return [parsedContents];
							} catch (parseErr) {
								logger.error(`Cannot load from ${inputFileName}: ${parseErr.message}`);
								return [];
							}
						}).reduce((agg, documents) => {
							return agg.concat(documents);
						}, []).forEach(document => {
							// A valid resource at least has a apiVersion and kind, otherwise just report
							// an error and skip it.
							if (!document.apiVersion || !document.kind) {
								logger.error(`${inputFileName}: Ignoring invalid resource definition`);
								return;
							}

							// Annotations and labels applied to each resource.
							// For easy filtering/selecting of resources in complex projects as well as being able to trace
							// the origin of a resource back to a file we provide the source directory, source file name, and complete
							// source file name relative to the template directory.
							// Unfortunately we cannot use arbitrary content in label values, so the each invalid character is replaced by a '_'.
							// XXX: kubectl always sets the annotations, even when they are empty.
							const annotations = {};
							const labels = {
								'bootstrap.k8s.collaborne.com/source-directory': util.cleanLabelValue(path.dirname(relativeInputFileName)),
								'bootstrap.k8s.collaborne.com/source-file': util.cleanLabelValue(relativeInputFileName),
								'bootstrap.k8s.collaborne.com/source-name': util.cleanLabelValue(path.basename(relativeInputFileName))
							};

							// Set the namespace for the current configuration to the environment, so that our resources
							// are properly isolated from other environments.
							const resource = deepMerge(document, {
								metadata: {
									annotations,
									labels
								}
							});

							// Assign a namespace, iff that resource exists in namespaces.
							logger.trace(`${inputFileName}: Processing ${resource.apiVersion}/${resource.kind} ${resource.metadata.name}`);
							resourcePromises.push(processResource(resource, inputFileName));
						});

						return next();
					});
				});
			});
		});
		walker.on('end', () => {
			resolve(Promise.all(resourcePromises));
		});
	});
}

function loadProperties(settingsFileNames, commandlineProperties) {
	return new Promise((resolve, reject) => {
		function mergeProperties(deployProperties) {
			let environment = deployProperties.environment || commandlineProperties.environment;
			if (!environment) {
				throw new Error('Unknown environment, aborting');
			}

			environment = environment.replace(/[^a-zA-Z0-9-]+/g, '-');
			logger.info(`Using environment name '${environment}'`);
			const internalProperties = {
				environment
			};

			return deepMerge.all([deployProperties, commandlineProperties, internalProperties]);
		}

		const deployProperties = settingsFileNames.map(fileName => {
			let contents;
			try {
				if (fs.statSync(fileName).isFile()) {
					logger.debug(`Loading ${fileName}`);
					contents = fs.readFileSync(fileName, 'UTF-8');
				} else {
					return reject(new Error(`${fileName} exists, but is not a file.`));
				}
			} catch (err) {
				// File doesn't exist.
				logger.warn(`Cannot read ${fileName}: ${err.message}`);
				return {};
			}

			return yaml.safeLoad(contents);
		}).reduce(deepMerge, {});

		return resolve(mergeProperties(deployProperties));
	});
}

function resolveModules(includedModules, excludedModules) {
	// Calculate the modules to use:
	// Start from all in templates/, filtered by the ones explicitly given, removing all that are explicitly removed.
	return new Promise((resolve, reject) => {
		fs.readdir(argv.templateDirectory, (err, availableModules) => {
			if (err) {
				return reject(err);
			}

			if (includedModules.length > 0) {
				// Find "missing" modules: The user wanted these, but they are not actually available.
				const missingModules = includedModules.filter(m => availableModules.indexOf(m) === -1);
				if (missingModules.length > 0) {
					return reject(new Error(`Cannot use unavailable modules ${missingModules}`));
				}

				// Next, check that we don't have conflicts: If the user says we should include X _and_ exclude X, something is off.
				const conflictingModules = includedModules.filter(m => excludedModules.indexOf(m) !== -1);
				if (conflictingModules.length > 0) {
					return reject(new Error(`Cannot both include and exclude modules ${conflictingModules}`));
				}
			}

			// Now filter available modules
			const resolvedModules = availableModules
				.filter(m => includedModules.length === 0 || includedModules.indexOf(m) !== -1)
				.filter(m => excludedModules.indexOf(m) === -1);
			logger.info(`Using modules ${resolvedModules.join(',')}`);
			return resolve(resolvedModules);
		});
	});
}

async function main() {
	const properties = util.definesToObject(argv.define);

	const settingsFileNames = [argv.deploySettings];
	if (!argv.disableOverrides && argv.deploySettingsOverrides) {
		settingsFileNames.push(argv.deploySettingsOverrides);
	}

	const loadedProperties = await loadProperties(settingsFileNames.map(settingsFileName => path.resolve(settingsFileName)), properties);
	// Log the properties before adding the environment variables into them
	// Environment variables contain typically weird things, and likely secrets that we do not want to expose here
	logger.debug(`Resolved properties: ${JSON.stringify(loadedProperties, null, 2)}`);

	const mergedProperties = Object.assign({}, loadedProperties, {env: process.env});
	const namespace = mergedProperties.environment;

	let prepare;
	let processResource;
	if (argv.outputOnly) {
		prepare = Promise.resolve();
		processResource = resource => {
			return Promise.resolve(resource);
		};
	} else {
		const k8sClient = await k8s(argv.kubeconfig, argv.context, '');
		prepare = ensureNamespace(k8sClient, namespace, {}).then(ns => {
			if (argv.authorize) {
				return authorizeK8s(argv.kubeconfig, ns.metadata.name, argv.serviceAccount, false, 'collaborne-registry');
			}

			// Ignored by caller
			return undefined;
		});
		processResource = (resource, location) => {
			const k8sResource = k8sClient.group(resource.apiVersion).resource(resource.kind);
			if (!k8sResource) {
				const msg = `Cannot find resource ${resource.apiVersion}/${resource.kind}`;
				logger.error(`${location}: ${msg}`);
				return Promise.reject(new Error(msg));
			}
			if (k8sResource.namespaced) {
				resource.metadata.namespace = namespace;
			}

			return applyResource(k8sClient, resource);
		};
	}

	if (argv.includeKind && argv.includeKind.length > 0) {
		const innerProcessResource = processResource;
		processResource = (resource, location) => {
			// Must have specified either 'kind' or 'api.version/kind' to be included.
			const matchKind = `${resource.apiVersion}.${resource.kind}`;
			if (argv.includeKind.indexOf(resource.kind) === -1 && argv.includeKind.indexOf(matchKind) === -1) {
				logger.debug(`Skipping ${resource.apiVersion}.${resource.kind} ${resource.metadata.name}: Not explicitly included`);
				return Promise.resolve(resource);
			}

			return innerProcessResource(resource, location);
		};
	}

	await prepare;
	const modules = await resolveModules(argv._, argv.exclude);
	const resources = await processTemplates(argv.templateDirectory, modules, argv.outputDirectory, mergedProperties, processResource);
	logger.info(`Created ${resources.length} resources`);
}

main().catch(err => {
	logger.error(`Cannot apply resources: ${err.message}`, err);
	process.exitCode = 1;
});
