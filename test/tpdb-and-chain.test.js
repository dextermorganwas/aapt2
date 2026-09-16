'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tpdb = require('../src/providers/theposterdb');
const tvdb = require('../src/providers/tvdb');

test('TPDb show-cover parser excludes season covers', () => {
  assert.equal(tpdb.parseShowCaption('Planet Earth (2006)'), 'Cover');
  assert.equal(tpdb.parseShowCaption('Planet Earth (2006) - Season 1'), 1);
  assert.equal(tpdb.parseShowCaption('Planet Earth (2006) - Specials'), 0);
});

test('TPDb search parser returns poster-set links, not arbitrary poster assets', () => {
  const targets = tpdb.parseSearchTargets(`
    <a href="/posters/6792">Planet Earth (2006)</a>
    <div data-poster-id="114737">War on Everyone (2016)</div>
  `);
  assert.deepEqual(targets, [{ id: '6792', text: 'Planet Earth (2006)', year: '2006' }]);
  assert.equal(tpdb.exactTarget(targets, 'Planet Earth', '2006').id, '6792');
});

test('TVDB textless picker prefers explicit includesText=false in API order', () => {
  const value = tvdb.pickFirstTextless([
    { id: 1, includesText: true, language: null },
    { id: 2, includesText: false, language: 'eng' },
    { id: 3, includesText: false, language: null },
  ]);
  assert.equal(value.id, 2);
});
