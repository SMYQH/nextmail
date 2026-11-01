import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePositiveSafeInteger } from '../app/lib/max-emails'

test('mailbox limit parser accepts exact positive safe integers in number-input notation', () => {
  const cases: Array<[string, number]> = [
    ['1', 1], ['30', 30], ['9007199254740991', Number.MAX_SAFE_INTEGER],
    [' 00042 ', 42], ['+2', 2], ['2.0', 2], ['.1e1', 1], ['2e3', 2000],
    ['1200e-2', 12], ['1.0000000000000000', 1],
  ]
  for (const [value, expected] of cases) assert.equal(parsePositiveSafeInteger(value), expected, value)
})

test('mailbox limit parser rejects invalid types, nonpositive, fractional, and unsafe values', () => {
  const values = [undefined, null, 1, true, {}, [], '', ' ', 'abc', '-5', '0', '-0',
    '1.5', '0.5', '9007199254740992', '1e309', 'Infinity', 'NaN', '0x10', '0b10', '1_000', '1e']
  for (const value of values) assert.equal(parsePositiveSafeInteger(value), null, String(value))
})

test('mailbox limit parser does not round a fractional string into an allowed integer', () => {
  for (const value of ['1.0000000000000001', '0.99999999999999999',
    '9007199254740991.1', '9007199254740990.9', '90071992547409911e-1']) {
    assert.equal(parsePositiveSafeInteger(value), null, value)
  }
})
