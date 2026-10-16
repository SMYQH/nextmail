import assert from 'node:assert/strict'
import test from 'node:test'
import { generateAvatarUrl } from '../app/lib/avatar'

const decodeAvatar = (name: string) => decodeURIComponent(generateAvatarUrl(name).split(',')[1])

test('generated avatars support empty names and Unicode initials', () => {
  assert.match(decodeAvatar('  '), />\s*\?\s*<\/text>/)
  assert.match(decodeAvatar(' 🦊 User'), />\s*🦊\s*<\/text>/)
  assert.match(decodeAvatar('中文'), />\s*中\s*<\/text>/)
  assert.equal(generateAvatarUrl('Alice'), generateAvatarUrl('Alice'))
})

test('generated avatars escape user initials as SVG text', () => {
  assert.match(decodeAvatar('<script>'), />\s*&lt;\s*<\/text>/)
  assert.match(decodeAvatar('&name'), />\s*&amp;\s*<\/text>/)
  assert.doesNotMatch(decodeAvatar('<script>'), /<script>/)
})
