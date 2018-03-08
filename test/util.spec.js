'use strict'

const assert = require('assert');
const util = require('../src/util.js');

describe('util functions', function() {
	describe('#definesToObject()', function() {
		it('should return an empty object for an empty list', function() {
			assert.deepEqual({}, util.definesToObject([]));
		});
		it('should convert key=value to a property', function() {
			assert.deepEqual({ foo: 'bar'}, util.definesToObject(['foo=bar']))
		});
		it('should convert keyA.keyB=value to a property', function() {
			assert.deepEqual({ foo: { bar: 'baz' }}, util.definesToObject(['foo.bar=baz']))
		});
		it('should convert multiple key=value to properties', function() {
			assert.deepEqual({ foo: 'bar', baz: { quux: 'quuux' }}, util.definesToObject(['foo=bar', 'baz.quux=quuux']))
		});
		it('should convert JSON string to a property', function() {
			assert.deepEqual({ foo: 'bar'}, util.definesToObject(['foo="bar"']));
		});
		it('should convert JSON array to a property', function() {
			assert.deepEqual({ foo: ['bar', 'baz']}, util.definesToObject(['foo=["bar","baz"]']));
		});
		it('should convert JSON object to a property', function() {
			assert.deepEqual({ foo: { bar: 'baz' }}, util.definesToObject(['foo={"bar":"baz"}']));
		});
	});

	describe('#cleanOrigin()', function() {
		it('should return a valid origin without port unmodified', function() {
			assert.equal('https://example.com', util.cleanOrigin('https://example.com'));
		});
		it('should return a valid origin with port unmodified', function() {
			assert.equal('https://example.com:8443', util.cleanOrigin('https://example.com:8443'));
		});
		it('should strip a path from an origin without port', function() {
			assert.equal('https://example.com', util.cleanOrigin('https://example.com/path'));
		});
		it('should strip a path from an origin with port', function() {
			assert.equal('https://example.com:8443', util.cleanOrigin('https://example.com:8443/path'));
		});
	});
});
