const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const yaml = require('js-yaml');
const k8s = require('auto-kubernetes-client');

const logger = require('log4js').getLogger('kubernetes-bootstrap.k8s-client');

function lookupByName(list, name, valueKey) {
	return list.filter(e => e.name === name).map(e => e[valueKey]).shift();
}

async function loadKubeConfig(kubeConfigPath) {
	// Split the given config path on the usual path separator, then load the configurations
	// _sequentially_, each later one overwriting/merging with the previous one.
	const kubeConfigPaths = kubeConfigPath.split(':');
	const kubeConfigDescPromises = kubeConfigPaths.map(p => {
		return new Promise(resolve => {
			fs.readFile(p, 'utf-8', (err, data) => {
				if (err) {
					logger.warn(`${p}: Cannot load: ${err.message}`);
					resolve({error: err.message});
					return;
				}

				resolve({[p]: yaml.safeLoad(data)});
			});
		});
	});

	const kubeConfigDescs = await Promise.all(kubeConfigDescPromises);
	return kubeConfigDescs.reduce((agg, kubeConfig) => {
		if (kubeConfig.error) {
			// Skip this one
			return agg;
		}

		// Otherwise: Merge the configs, and append the path so we keep the order.
		Object.assign(agg.configs, kubeConfig);
		agg.paths.push(...Object.keys(kubeConfig));
		return agg;
	}, {
		configs: {},
		paths: [],
	});
}

/**
 * Create a kubernetes client instance for the current kubectl context.
 *
 * This function loads the configuration for kubectl from its default
 * location, and then returns a suitable client for that environment.
 *
 * @param {string} kubeConfigPath path to the kubectl configuration
 * @param {string} [context] the context to connect to, default is to use the "current" context.
 * @return a client for the current k8s environment
 */
// FIXME: This probably should move into a helper in auto-kubernetes-client
async function create(kubeConfigPath, context) {
	const kubeConfig = await loadKubeConfig(kubeConfigPath);

	// First: Find the "current context" and resolve the configuration
	// Note that kubectl picks the first `current-context` it finds in the configurations, and doesn't let later
	// configs overwrite earlier configs.
	let currentContext = context;
	if (!currentContext) {
		for (const p of kubeConfig.paths) {
			const config = kubeConfig.configs[p];
			currentContext = config['current-context'];
			if (currentContext) {
				break;
			}
		}
	}

	if (!currentContext) {
		throw new Error('Cannot find a context, and no context provided');
	}

	// Find the context configuration itself
	// We're assuming here that each of the pieces of the configuration could potentially be defined in another file,
	// so that a user could have a shared "global settings" configuration, and then a per-project/-workspace/... configuration
	// that only specifies the context.
	let contextConfig;
	for (const p of kubeConfig.paths.reverse()) {
		contextConfig = lookupByName(kubeConfig.configs[p].contexts, currentContext, 'context');
		if (contextConfig) {
			// Found the configuration itself
			break;
		}
	}
	if (!contextConfig) {
		throw new Error(`Cannot find context configuration for ${currentContext}, check ${kubeConfigPath}`);
	}

	// Find the cluster definition
	let url;
	let ca;
	for (const p of kubeConfig.paths.reverse()) {
		const clusterConfig = lookupByName(kubeConfig.configs[p].clusters, contextConfig.cluster, 'cluster');
		if (clusterConfig) {
			url = clusterConfig.server;
			if (clusterConfig['certificate-authority-data']) {
				ca = Buffer.from(clusterConfig['certificate-authority-data'], 'base64').toString();
			} else if (clusterConfig['certificate-authority']) {
				ca = fs.readFileSync(path.resolve(path.dirname(p), clusterConfig['certificate-authority']));
			} else {
				throw new Error(`Cannot find certificate authority information for cluster ${contextConfig.cluster} in ${p}`);
			}
			break;
		}
	}
	if (!url || !ca) {
		throw new Error(`Cannot find cluster configuration for ${contextConfig.cluster}, check ${kubeConfigPath}`);
	}

	// Find the user definition
	let accessConfigPromise;
	for (const p of kubeConfig.paths.reverse()) {
		const userConfig = lookupByName(kubeConfig.configs[p].users, contextConfig.user, 'user');
		if (userConfig) {
			if (userConfig.cert && userConfig.key) {
				accessConfigPromise = Promise.resolve({
					cert: fs.readFileSync(path.resolve(path.dirname(p), userConfig['client-certificate'])),
					key: fs.readFileSync(path.resolve(path.dirname(kubeConfigPath), userConfig['client-key'])),
				});
			} else if (userConfig.token) {
				accessConfigPromise = Promise.resolve({
					token: userConfig.token,
				});
			} else if (userConfig.exec) {
				// Spawn the tool
				accessConfigPromise = new Promise((resolve, reject) => {
					let output = '';
					let error = '';
					// XXX: Is it really a good idea to start out with the complete environment?
					// https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins doesn't specify much here.
					let env = Object.assign({}, process.env);
					if (userConfig.exec.env) {
						env = Object.assign(env, userConfig.exec.env.reduce((agg, envEntry) => Object.assign(agg, {[envEntry.name]: envEntry.value}), {}));
					}
					const authenticator = spawn(userConfig.exec.command, userConfig.exec.args || [], {env});
					authenticator.stdout.on('data', data => {
						output += data;
					});
					authenticator.stderr.on('data', data => {
						error += data;
					});
					authenticator.on('close', code => {
						if (code !== 0) {
							reject(new Error(error));
							return;
						}

						const parsedOutput = JSON.parse(output);
						if (parsedOutput.apiVersion !== 'client.authentication.k8s.io/v1alpha1' || parsedOutput.kind !== 'ExecCredential') {
							reject(new Error(`Unexpected authenticator result ${parsedOutput.apiVersion}/${parsedOutput.kind}`));
							return;
						}

						resolve(parsedOutput.status);
					});
				});
			} else {
				throw new Error(`Cannot load user configuration for ${contextConfig.user} in ${p}`);
			}
			break;
		}
	}

	// Then: Load the context, resolving path references against the path of the configuration itself
	if (!accessConfigPromise) {
		throw new Error(`Cannot find user configuration for ${contextConfig.user}, check ${kubeConfigPath}`);
	}

	const accessConfig = await accessConfigPromise;
	const config = Object.assign({url: url, ca: ca}, accessConfig);
	return k8s(config);
}

module.exports = create;
