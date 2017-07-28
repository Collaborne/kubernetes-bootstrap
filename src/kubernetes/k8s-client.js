'use strict'

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const k8s = require('auto-kubernetes-client');

function lookupByName(list, name, valueKey) {
	return list.filter(e => e.name === name).map(e => e[valueKey]).shift();
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
	return new Promise(function(resolve, reject) {
		return fs.readFile(kubeConfigPath, 'UTF-8', function(err, data) {
			if (err) {
				return reject(err);
			}

			const kubeConfig = yaml.safeLoad(data);
			const currentContext = context || kubeConfig['current-context'];

			const contextConfig = lookupByName(kubeConfig.contexts, currentContext, 'context');
			if (!contextConfig) {
				return reject(new Error(`Cannot find context configuration for ${currentContext}, check ${kubeConfigPath}`));
			}
			const clusterConfig = lookupByName(kubeConfig.clusters, contextConfig.cluster, 'cluster');
			if (!clusterConfig) {
				return reject(new Error(`Cannot find cluster configuration for ${contextConfig.cluster}, check ${kubeConfigPath}`));
			}
			const userConfig = lookupByName(kubeConfig.users, contextConfig.user, 'user');
			if (!userConfig) {
				return reject(new Error(`Cannot find user configuration for ${contextConfig.user}, check ${kubeConfigPath}`));
			}

			const config = {
				url: clusterConfig.server,
				ca: fs.readFileSync(path.resolve(path.dirname(kubeConfigPath), clusterConfig['certificate-authority'])),
				cert: fs.readFileSync(path.resolve(path.dirname(kubeConfigPath), userConfig['client-certificate'])),
				key: fs.readFileSync(path.resolve(path.dirname(kubeConfigPath), userConfig['client-key']))
			}

			return resolve(k8s(config));
		});
	});
}

module.exports = create;
