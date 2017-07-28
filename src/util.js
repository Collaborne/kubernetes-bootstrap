'use strict'

const deepMerge = require('deepmerge');
const URI = require('urijs');

/**
 * Convert a list of 'name[.name..]=value' into an object with these properties
 *
 * @param {Array} defines list of definitions
 * @return {Object}
 */
exports.definesToObject = function(defines) {
	const properties = defines.map(define => define.split('=')).map(function(kv) {
		const name = kv[0];

		let value;
		if (kv[1].startsWith('[') || kv[1].startsWith('{') || kv[1].startsWith('"')) {
			value = JSON.parse(kv[1]);
		} else {
			value = kv[1];
		}

		const reversePath = name.split('.').reverse();
		return reversePath.reduce((obj, name) => ({ [name]: obj }), value);
	}, {});
	return properties.reduce(deepMerge, {});
}

/**
 * Clean a given URI to be a valid "origin".
 *
 * @param {string} uri
 * @return {string}
 */
exports.cleanOrigin = function(uri) {
	const originalOrigin = URI(uri);

	// Strip out any path, as that confuses shindig and is not part of an origin.
	return originalOrigin.protocol() + '://' + originalOrigin.host();
}
