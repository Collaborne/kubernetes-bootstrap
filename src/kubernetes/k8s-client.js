const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const yaml = require('js-yaml');
const k8s = require('auto-kubernetes-client');

function lookupByName(list, name, valueKey) {
	return list.filter(e => e.name === name).map(e => e[valueKey]).shift();
}

function loadKubeConfig(kubeConfigPath) {
	// Split the given config path on the usual path separator, then load the configurations
	// _sequentially_, each later one overwriting/merging with the previous one.
	const kubeConfigPaths = kubeConfigPath.split(':')
	const kubeConfigDescPromises = kubeConfigPaths.map(kubeConfigPath => {
		return new Promise((resolve, reject) => {
			fs.readFile(kubeConfigPath, 'utf-8', (err, data) => {
				if (err) {
					reject(err);
					return;
				}

				resolve({[kubeConfigPath]: yaml.safeLoad(data)});
			});
		});
	});

	return Promise.all(kubeConfigDescPromises).then(kubeConfigDescs => {
		return {
			paths: kubeConfigPaths,
			configs: kubeConfigDescs.reduce((agg, kubeConfig) => Object.assign({}, agg, kubeConfig), {})
		};
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
function create(kubeConfigPath, context) {
	return loadKubeConfig(kubeConfigPath)
		.then(kubeConfig => {
			// First: Find the "current context" and resolve the configuration
			let i = kubeConfig.paths.length - 1;
			let currentContext = context;
			while (!currentContext && i >= 0) {
				const path = kubeConfig.paths[i];
				const config = kubeConfig.configs[path];
				currentContext = config['current-context'];
				if (!currentContext) {
					i--;
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

			return accessConfigPromise.then(accessConfig => {
				const config = Object.assign({url: url, ca: ca}, accessConfig);
				return k8s(config);
			});
		});
}

module.exports = create;
