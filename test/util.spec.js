const assert = require('assert');
const util = require('../src/util.js');

describe('util functions', () => {
	describe('#definesToObject()', () => {
		it('should return an empty object for an empty list', () => {
			assert.deepEqual({}, util.definesToObject([]));
		});
		it('should convert key=value to a property', () => {
			assert.deepEqual({foo: 'bar'}, util.definesToObject(['foo=bar']));
		});
		it('should convert keyA.keyB=value to a property', () => {
			assert.deepEqual({foo: {bar: 'baz'}}, util.definesToObject(['foo.bar=baz']));
		});
		it('should convert multiple key=value to properties', () => {
			assert.deepEqual({foo: 'bar', baz: {quux: 'quuux'}}, util.definesToObject(['foo=bar', 'baz.quux=quuux']));
		});
		it('should convert JSON string to a property', () => {
			assert.deepEqual({foo: 'bar'}, util.definesToObject(['foo="bar"']));
		});
		it('should convert JSON array to a property', () => {
			assert.deepEqual({foo: ['bar', 'baz']}, util.definesToObject(['foo=["bar","baz"]']));
		});
		it('should convert JSON object to a property', () => {
			assert.deepEqual({foo: {bar: 'baz'}}, util.definesToObject(['foo={"bar":"baz"}']));
		});
	});

	describe('#cleanLabelValue()', () => {
		it('should accept a valid value without changes', () => {
			const validValue = 'valid-value-123.FOO_BAR';
			assert.equal(validValue, util.cleanLabelValue(validValue));
		});
		it('should replace invalid characters with (multiple) _', () => {
			assert.equal('invalid__value', util.cleanLabelValue('invalid/#value'));
		});
	});

	describe('#cleanOrigin()', () => {
		it('should return a valid origin without port unmodified', () => {
			assert.equal('https://example.com', util.cleanOrigin('https://example.com'));
		});
		it('should return a valid origin with port unmodified', () => {
			assert.equal('https://example.com:8443', util.cleanOrigin('https://example.com:8443'));
		});
		it('should strip a path from an origin without port', () => {
			assert.equal('https://example.com', util.cleanOrigin('https://example.com/path'));
		});
		it('should strip a path from an origin with port', () => {
			assert.equal('https://example.com:8443', util.cleanOrigin('https://example.com:8443/path'));
		});
	});
});
