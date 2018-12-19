const deepMerge = require('deepmerge');
const URI = require('urijs');

/**
 * Convert a list of 'name[.name..]=value' into an object with these properties
 *
 * @param {Array} defines list of definitions
 * @return {Object}
 */
function definesToObject(defines) {
	const properties = defines.map(define => define.split('=')).map(kv => {
		const name = kv[0];

		let value;
		if (kv[1].startsWith('[') || kv[1].startsWith('{') || kv[1].startsWith('"')) {
			value = JSON.parse(kv[1]);
		} else {
			value = kv[1];
		}

		const reverseSegments = name.split('.').reverse();
		return reverseSegments.reduce((obj, segment) => ({[segment]: obj}), value);
	}, {});
	return properties.reduce((agg, value) => deepMerge(agg, value), {});
}

/**
 * Clean a given URI to be a valid "origin".
 *
 * @param {string} uri
 * @return {string}
 */
function cleanOrigin(uri) {
	const originalOrigin = URI(uri);

	// Strip out any path, as that confuses shindig and is not part of an origin.
	return `${originalOrigin.protocol()}://${originalOrigin.host()}`;
}

/**
 * Clean a given value to be a valid "label value".
 *
 * @param {string} value value to be cleaned
 * @return {string} cleaned label value
 * @see https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/
 */
function cleanLabelValue(value) {
	return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

module.exports = {
	cleanLabelValue,
	cleanOrigin,
	definesToObject,
};
