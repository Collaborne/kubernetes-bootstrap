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
const logger = log4js.getLogger();

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
	.string('template-directory').default('template-directory', 'templates').normalize('template-directory').describe('template-directory', 'Base directory for templates')
	.string('deploy-settings').default('deploy-settings', 'deploy.yaml').describe('deploy-settings', 'Settings to use for processing the templates')
	.string('deploy-settings-overrides').default('deploy-settings-overrides', 'deploy.yaml.override').describe('deploy-settings-overrides', 'Additional settings to load')
	.boolean('disable-overrides').describe('disable-overrides', 'Do not apply deploy.yaml.override')
	.string('output-directory').default('output-directory', 'target').normalize('output-directory').describe('output-directory', 'Directory in which procesed templates are written')
	.boolean('output-only').describe('output-only', 'Only produce the output files, but do not apply them to the cluster')
	.string('kubeconfig').default('kubeconfig', process.env.KUBECONFIG || path.resolve(userDir, '.kube/config')).describe('kubeconfig', 'Kubectl configuration file to use for connecting to the cluster')
	.string('content').default('context', undefined).describe('context', 'Context in the kubectl configuration to use')
	.array('exclude').default('exclude', []).alias('x', 'exclude').describe('exclude', 'Template module to exclude')
	.array('define').default('define', []).alias('D', 'define').describe('define', 'Define/Override a setting on the command-line')
	.array('include-kind').default('include-kind', []).describe('include-kind', 'Only include resources of the given kind')
	.coerce(['exclude', 'define'], value => {
		return typeof value === 'string' ? [value] : value;
	})
	.help()
	.strict()
	.parse(args);

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
		if (err.reason === 'NotFound') {
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

function getApplyFlags(annotations) {
	// Process all annotations into flags.
	// If there are annotations for this tool that we do not know: Immediately abort, as these
	// annotations may require a behavior that we simply do not provide.
	const group = 'bootstrap.k8s.collaborne.com';
	const flags = {
		IGNORE_PATCH_FAILURES: false,
		MANUAL_ONLY: false,
		UPDATE_ALLOWED: true,
	};
	for (const annotation of Object.keys(annotations)) {
		if (!annotation.startsWith(`${group}/`)) {
			// Irrelevant for us.
			continue;
		}
		const name = annotation.substring(annotation.indexOf('/') + 1);
		const value = annotations[annotation];
		switch (name) {
		case 'ignore-patch-failures':
			flags.IGNORE_PATCH_FAILURES = value === 'true';
			break;
		case 'manual':
			flags.MANUAL_ONLY = value === 'true';
			break;
		case 'update-allowed':
			flags.UPDATE_ALLOWED = value === 'true';
			break;
		default:
			throw new Error(`Unrecognized annotation '${annotation}'`);
		}
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

	let k8sResource;
	try {
		const k8sGroup = k8sClient.group(resource.apiVersion);

		let accessor;
		if (resource.metadata && resource.metadata.namespace) {
			const k8sNamespace = k8sGroup.ns(resource.metadata.namespace);
			assert(Boolean(k8sNamespace));
			accessor = k8sNamespace[resource.kind.toLowerCase()];
		} else {
			accessor = k8sGroup[resource.kind.toLowerCase()];
		}

		if (!accessor) {
			throw new Error(`Cannot find API for creating ${getLogName(resource)}`);
		}

		k8sResource = accessor(resource.metadata.name);
	} catch (err) {
		throw new Error(`Cannot instantiate the API for creating ${getLogName(resource)}: ${err.message}`);
	}

	/** The last attempted operation */
	let op;

	/** The result of that operation */
	let result;
	try {
		// First try patching, then replacing, and and fall back to creation if the object doesn't exist.
		// TODO: replace might fail, but we can try delete+post.
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
			} else if (err.reason === 'NotFound') {
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
			} else if (flags.IGNORE_PATCH_FAILURES) {
				// Certain resources are "one-shot": When jobs exist many fields are immutable, but that's perfectly fine: the job represents
				// the state at which it executed. If a resource has the annotation bootstrap.k8s.collaborne.com/ignore-patch-failures, we ignore
				// patch failures gracefully.
				op = 'SKIP';
				result = {status: `Ignoring patch failure: ${err.message}`};
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
 * Function that processes a single resource
 *
 * @callback processCallback
 * @param {Object} resource the resource object to process
 * @return {Promise<Object>} a promise that resolves when the resource has been applied
 */

/**
 * @param {Client} k8sClient
 * @param {String} templatesDir
 * @param {Array<String>} modules
 * @param {String} outputDir,
 * @param {Object} properties
 * @param {processCallback} processResource function to call with a single resource
 */
function processTemplates(k8sClient, templatesDir, modules, outputDir, properties, processResource) {
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
							const k8sResource = k8sClient.group(resource.apiVersion).resource(resource.kind);
							if (!k8sResource) {
								logger.error(`${inputFileName}: Cannot find resource ${resource.apiVersion}/${resource.kind}`);
								return;
							}
							if (k8sResource.namespaced) {
								resource.metadata.namespace = properties.environment;
							}

							resourcePromises.push(processResource(resource));
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
	const k8sClient = await k8s(argv.kubeconfig, argv.context, '');
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

	let prepare;
	let processResource;
	if (argv.outputOnly) {
		prepare = Promise.resolve();
		processResource = resource => {
			logger.debug(`Processing: ${JSON.stringify(resource)}`);
			return Promise.resolve(resource);
		};
	} else {
		const namespace = mergedProperties.environment;
		prepare = ensureNamespace(k8sClient, namespace, {}).then(ns => {
			if (argv.authorize) {
				return authorizeK8s(argv.kubeconfig, ns.metadata.name, argv.serviceAccount, false, 'collaborne-registry');
			}

			// Ignored by caller
			return undefined;
		});
		processResource = applyResource.bind(undefined, k8sClient);
	}

	if (argv.includeKind && argv.includeKind.length > 0) {
		const innerProcessResource = processResource;
		processResource = resource => {
			// Must have specified either 'kind' or 'api.version/kind' to be included.
			const matchKind = `${resource.apiVersion}.${resource.kind}`;
			if (argv.includeKind.indexOf(resource.kind) === -1 && argv.includeKind.indexOf(matchKind) === -1) {
				logger.debug(`Skipping ${resource.apiVersion}.${resource.kind} ${resource.metadata.name}: Not explicitly included`);
				return Promise.resolve(resource);
			}

			return innerProcessResource(resource);
		};
	}

	await prepare;
	const modules = await resolveModules(argv._, argv.exclude);
	const resources = await processTemplates(k8sClient, argv.templateDirectory, modules, argv.outputDirectory, mergedProperties, processResource);
	logger.info(`Created ${resources.length} resources`);
}

main().catch(err => {
	logger.error(`Cannot apply resources: ${err.message}`, err);
	process.exitCode = 1;
});
