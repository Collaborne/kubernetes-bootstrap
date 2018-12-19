const AWS = require('aws-sdk');

const k8s = require('./k8s-client.js');

const logger = require('log4js').getLogger();

function applySecretsToServiceAccount(k8sClient, namespace, serviceAccount, imagePullSecretsName) {
	// Modify the "default" service account with these new secrets.
	return k8sClient.ns(namespace).serviceaccount(serviceAccount).patch({
		imagePullSecrets: [ { name: imagePullSecretsName } ]
	});
}

/**
 * Authorize a K8s service account for using AWS ECR.
 *
 * This is intended for local work using minikube or similar technologies; kubernetes running
 * inside AWS ECS is already able to work with ECR using IAM credentials.
 *
 * @param {string} kubeConfigPath path to the kubectl configuration
 * @param {string} [namespace] the namespace to use
 * @param {string} [serviceAccount] the service account to use, default is 'default'.
 * @param {boolean} [allowAnyContext] if `true` then the current context will be used, otherwise the `minikube` context
 * @param {string} [secretName] name of the secrets to work with, default is 'collaborne-registry'
 * @return {Promise} a promise that resolves when the context is authorized
 */
function authorizeK8s(kubeConfigPath, namespace = 'default', serviceAccount = 'default', allowAnyContext = false, secretName = 'collaborne-registry') {
	// NB: You might have to provide the AWS_PROFILE environment variable for this to work.
	// Restrict credential sources
	const credentialProviderChain = new AWS.CredentialProviderChain([
		() => new AWS.EnvironmentCredentials('AWS'),
		() => new AWS.SharedIniFileCredentials()
	]);
	const ecrPromise = credentialProviderChain.resolvePromise().then(credentials => {
		logger.debug(`Using credentials with access key id ${credentials.accessKeyId}`);

		return new AWS.ECR({
			region: process.env.AWS_DEFAULT_REGION || 'eu-west-1',
			endpoint: process.env.AWS_ENDPOINT,

			credentials: credentials,
			credentialProvider: credentialProviderChain,
			// Reset these two by force.
			accessKeyId: null,
			secretAccessKey: null
		});
	}, err => {
		logger.error(`Cannot find any credentials for AWS ECR: ${err.message}`, err);
		throw new Error('ECR credentials are required');
	});
	const k8sPromise = k8s(kubeConfigPath, allowAnyContext ? null : 'minikube');
	const acquireClients = Promise.all([ecrPromise.then(ecr => ({ ecr })), k8sPromise.then(k8sClient => ({ k8sClient }))]).then(clients => clients.reduce(Object.assign, {}));

	return acquireClients.then(function({ecr, k8sClient}) {
		return new Promise(function(resolve, reject) {
			return ecr.getAuthorizationToken({}, function(err, data) {
				if (err) {
					return reject(new Error(`Cannot get ECR credentials: ${err}`));
				}

				const dockerConfig = {
					auths: data.authorizationData.reduce((agg, item) => Object.assign(agg, {
						[item.proxyEndpoint]: {
							auth: item.authorizationToken
							// XXX: email: 'none'
						}
					}), {})
				};
				const collaborneRegistrySecrets = {
					apiVersion: 'v1',
					kind: 'Secret',
					metadata: {
						name: secretName,
						namespace: namespace
					},
					data: {
						'.dockerconfigjson': Buffer.from(JSON.stringify(dockerConfig)).toString('base64')
					},
					type: 'kubernetes.io/dockerconfigjson'
				};

				const secret = k8sClient.ns(namespace).secret(collaborneRegistrySecrets.metadata.name);
				return secret.update(collaborneRegistrySecrets)
				.catch(err => {
					if (err.reason === 'NotFound') {
						return secret.create(collaborneRegistrySecrets).catch(err => { throw new Error(`Cannot create new docker-registry settings ${collaborneRegistrySecrets.metadata.name}: ${err.message}`); });
					}

					throw err;
				})
				.then(() => applySecretsToServiceAccount(k8sClient, namespace, serviceAccount, collaborneRegistrySecrets.metadata.name))
				.then(result => { logger.debug(`Service account ${serviceAccount} updated with AWS ECR credentials.`); return result; })
				.catch(err => { throw new Error(`Cannot update the ${serviceAccount} account: ${err.message}`); })
				.then(resolve, reject);
			});
		});
	});
}

// Export authorizeK8s as the sole thing from this module.
module.exports = authorizeK8s;
