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

const logger = require('log4js').getLogger();

const k8s = require('./kubernetes/k8s-client.js');
const authorizeK8s = require('./kubernetes/authorize-k8s.js');
const util = require('./util.js');

const userDir = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];

// XXX: yargs cannot handle -Dvar=value, so we preprocess the arguments and replace those with '--define', 'var=value'
const args = process.argv
	.slice(2)
	.map((arg) => arg.startsWith('-D') && arg.length > 2 ? ['--define', arg.substring(2)] : [arg])
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
	.string('kubeconfig').default('kubeconfig', path.resolve(userDir, '.kube/config')).describe('kubeconfig', 'Kubectl configuration file to use for connecting to the cluster')
	.string('content').default('context', undefined).describe('context', 'Context in the kubectl configuration to use')
	.array('exclude').default('exclude', ['aws']).alias('x', 'exclude').describe('exclude', 'Template module to exclude')
	.array('define').default('define', []).alias('D', 'define').describe('define', 'Define/Override a setting on the command-line')
	.coerce(['exclude', 'define'], value => typeof value === 'string' ? [value] : value)
	.help()
	.strict()
	.parse(args);
	
/**
 * Ensure that the namespace for the environment exists.
 *
 * @param {Object} k8sClient the kubernetes client
 * @param {string} environment
 * @param {Object} [extraLabels] additional labels to apply to the namespace
 * @param {Object} [extraAnnotations] additional annotations to apply to the namespace
 */
function ensureNamespace(k8sClient, environment, extraLabels = {}, extraAnnotations = {}) {
	const nsResource = k8sClient.namespace(environment);

	return nsResource.get().catch(err => {
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
					labels,
					annotations,
				}
			};
			return nsResource.create(namespace);
		}

		// Different error, let it bubble out.
		throw err;
	});
}

/**
 * Apply the given resource into the current kubernetes context.
 *
 * @param {Object} k8sClient the kubernetes client to use for applying the resource
 * @param {Object} resource
 */
function applyResource(k8sClient, resource) {
	const logName = `${resource.apiVersion}.${resource.kind} ${resource.metadata.name}`;

	if (resource.metadata.annotations && resource.metadata.annotations['bootstrap.k8s.collaborne.com/manual'] === 'true') {
		// Resource is not to be applied automatically, stop here.
		logger.info(`Skipping manual resource ${logName}`);
		return Promise.resolve(resource);
	}

	let k8sResource;
	try {
		const k8sGroup = k8sClient.group(resource.apiVersion);

		let accessor;
		if (resource.metadata && resource.metadata.namespace) {
			const k8sNamespace = k8sGroup.ns(resource.metadata.namespace);
			assert(!!k8sNamespace);
			accessor = k8sNamespace[resource.kind.toLowerCase()];
		} else {
			accessor = k8sGroup[resource.kind.toLowerCase()];
		}

		if (!accessor) {
			return Promise.reject(new Error(`Cannot find API for creating ${logName}`));
		}

		k8sResource = accessor(resource.metadata.name);
	} catch (err) {
		return Promise.reject(new Error(`Cannot instantiate the API for creating ${logName}: ${err.message}`));
	}

	function logResult(op) {
		return function(result) {
			logger.debug(`${op} ${logName}: ${JSON.stringify(result.status)}`);
			return result;
		};
	}

	// First try patching, then replacing, and and fall back to creation if the object doesn't exist.
	// TODO: replace might fail, but we can try delete+post.
	return k8sResource.patch(resource).then(logResult('PATCH')).catch(function(err) {
		// XXX: what would be the correct 'err.reason'?
		if (err.code === 405) {
			// Cannot patch, try replace
			return k8sResource.update(resource).then(logResult('UPDATE'));
		} else if (err.code === 500) {
			// Error on the server side, try replace.
			// This seems to happen with ThirdPartyResources in 1.5:
			// May 29 08:41:14 minikube localkube[24061]: E0529 08:41:14.784327   24061 errors.go:63] apiserver received an error that is not an unversioned.Status: unable to find api field in struct ThirdPartyResourceData for the json field "spec"
			logger.warn(`Received ${err.status}: ${err.message}, trying to replace the object`);
			return k8sResource.update(resource).then(logResult('UPDATE'));
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
			return k8sResource.create(deepMerge(resource, saveConfigMetadata)).then(logResult('CREATE'));
		} else if (resource.metadata.annotations && resource.metadata.annotations['bootstrap.k8s.collaborne.com/ignore-patch-failures'] === 'true') {
			// Certain resources are "one-shot": When jobs exist many fields are immutable, but that's perfectly fine: the job represents
			// the state at which it executed. If a resource has the annotation bootstrap.k8s.collaborne.com/ignore-patch-failures, we ignore
			// patch failures gracefully.
			return logResult('SKIP')({ status: `Ignoring patch failure: ${err.message}` });
		} else {
			throw err;
		}
	}).catch(function(err) {
		throw new Error(`Cannot apply resource ${logName}: ${err.message} (${err.operation})`);
	});
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
	return new Promise(function(resolve, reject) {
		const resourcePromises = [];
		const walker = walk.walk(templatesDir, {});
		let modulesFiltered = false;
		walker.on('directories', function(root, dirStatsArray, next) {
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
		walker.on('file', function(root, fileStats, next) {
			const ext = path.extname(fileStats.name);
			if (['.json', '.yml'].indexOf(ext) === -1) {
				// Skip unsupported files.
				return next();
			}
			const inputFileName = path.resolve(root, fileStats.name);
			fs.readFile(inputFileName, function(err, contents) {
				const outputFileName = path.resolve(outputDir, path.relative(templatesDir, inputFileName));
				mkdirp(path.dirname(outputFileName), function(err, made) {
					if (err) {
						logger.error(`Cannot create directory for ${outputFileName}: ${err.message}`);
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
					const renderedContents = mustache.render(template, properties, function(partial) {
						const filterConstructors = {
							indent(spaces = 2) {
								return function(s) {
									return s.replace(/^.+/gm, ' '.repeat(spaces) + '$&');
								}
							}
						}

						function parseFilterExpression(filterExpression) {
							let filterName;
							let args;
							const openIndex = filterExpression.indexOf('(');
							if (openIndex >= 0) {
								const closeIndex = filterExpression.indexOf(')', openIndex);
								args = filterExpression.substring(openIndex + 1, closeIndex).split(',').map(arg => arg.trim());
								filterName = filterExpression.substring(0, openIndex);
							} else {
								args = [];
								filterName = filterExpression;
							}
							const filterConstructor = filterConstructors[filterName];
							if (!filterConstructor) {
								throw new Error(`Cannot create filter '${filterExpression}': Unknown filter ${filterName}`);
							}
							return filterConstructor.apply(undefined, args);
						}

						// partial is filename[|function[([param[,param]]][|...]]
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
						const value = fs.readFileSync(source, 'UTF-8');
						return filters.reduce((result, filter) => filter.call(undefined, result), value);
					});
					return fs.writeFile(outputFileName, renderedContents, function(err) {
						if (err) {
							logger.error(`Cannot write ${outputFileName}: ${err.message}`);
							return next();
						}

						// Push the file also into k8s now
						// There are two ways for producting multiple items in a single yaml file, either the root-object is a v1.List,
						// or the documents are concatenated using '---'
						renderedContents.split(/^---+$/m).filter(document => document.trim().length > 0).map(function(document) {
							try {
								const parsedContents = yaml.safeLoad(document);
								if (parsedContents.kind === 'List') {
									return parsedContents.items;
								} else {
									return [parsedContents];
								}
							} catch (err) {
								logger.error(`Cannot load from ${inputFileName}: ${err.message}`);
								return [];
							}
						}).reduce(function(agg, documents) {
							return agg.concat(documents);
						}, []).forEach(document => {
							// Set the namespace for the current configuration to the environment, so that our resources
							// are properly isolated from other environments.
							// XXX: Also ensure we have the metadata.annotations field, which kubectl seems to do as well.
							const resource = deepMerge(document, {
								metadata: {
									annotations: {}
								}
							});

							// Assign a namespace, iff that resource exists in namespaces.
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
		walker.on('end', function() {
			resolve(Promise.all(resourcePromises));
		});
	});
}

function loadProperties(settingsFileNames, commandlineProperties) {
	return new Promise(function(resolve, reject) {
		function mergeProperties(deployProperties) {
			// niceName can be empty here, which is fine ... but then it must be explicitly configured
			// in the deploy.yaml or the command line.
			let environment = deployProperties.environment || commandlineProperties.environment;
			if (!environment) {
				throw new Error(`Unknown environment, aborting`);
			}

			environment = environment.replace(/[^a-zA-Z0-9-]+/g, '-')
			logger.info(`Using environment name '${environment}'`);
			const internalProperties = {
				environment
			};

			return deepMerge.all([deployProperties, commandlineProperties, internalProperties]);
		}

		const deployProperties = settingsFileNames.map(function(fileName) {
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
	function acceptModule(module) {
		if (includedModules.length > 0) {
			if (includedModules.indexOf(module) !== -1) {
				return false;
			}
		}

		return excludedModules.indexOf(module) === -1;
	}

	return new Promise(function(resolve, reject) {
		fs.readdir(argv.templateDirectory, function(err, availableModules) {
			if (err) {
				return reject(err);
			}

			const resolvedModules = availableModules.filter(acceptModule);
			logger.info(`Using modules ${resolvedModules.join(',')}`);
			return resolve(resolvedModules);
		});
	});
}

k8s(argv.kubeconfig, argv.context, '').then(function(k8sClient) {
	return Promise.resolve().then(() => {
		const properties = util.definesToObject(argv.define);

		const settingsFileNames = [argv.deploySettings];
		if (!argv.disableOverrides && argv.deploySettingsOverrides) {
			settingsFileNames.push(argv.deploySettingsOverrides);
		}
		
		return loadProperties(settingsFileNames.map(settingsFileName => path.resolve(settingsFileName)), properties);
	})
	.then(properties => {
		logger.debug(`Resolved properties: ${JSON.stringify(properties, null, 2)}`);

		let result;
		let processResource;
		if (argv.outputOnly) {
			result = Promise.resolve();
			processResource = (resource) => Promise.resolve(resource);
		} else {
			const namespace = properties.environment;
			result = ensureNamespace(k8sClient, namespace, {}).then(ns => {
				if (argv.authorize) {
					return authorizeK8s(argv.kubeconfig, ns.metadata.name, argv.serviceAccount, false, 'collaborne-registry');
				}
			});
			processResource = applyResource.bind(undefined, k8sClient);
		}

		return result
			.then(() => resolveModules(argv._, argv.exclude))
			.then(modules => processTemplates(k8sClient, argv.templateDirectory, modules, argv.outputDirectory, properties, processResource));
	})
	.then(resources => logger.info(`Created ${resources.length} resources`))
	.catch(err => {
		logger.error(`Cannot apply resources: ${err.message}`, err);
		process.exit(1);
	});
});
