import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contrastRatio, markInk } from '../src/mark-contrast.ts'

test('填充标记自动选择黑/白文字并保持可读对比度', () => {
  const colors = ['#000000', '#ffffff', '#808080', '#f5c66c', '#27966b', '#397aa6', '#cc3333', '#00ff00', '#1791a8']
  for (const color of colors) assert.ok(contrastRatio(color, markInk(color)) >= 4.5, color)
  assert.equal(markInk('#f5c66c'), '#000000')
  assert.equal(markInk('#000000'), '#ffffff')
  assert.equal(markInk('#ffffff'), '#000000')
  assert.equal(markInk('not-a-color'), '#ffffff')
})
