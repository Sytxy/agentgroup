import { describe, expect, test } from 'vitest'
import { outOfScopeFiles } from '../../src/main/services/git/path-scope'

describe('outOfScopeFiles', () => {
  test('outOfScopeFiles returns files outside web/** and tests/**', () => {
    const files = [
      'web/index.ts',
      'web/components/App.tsx',
      'tests/git/git-service.test.ts',
      'src/main/index.ts',
      'README.md'
    ]

    expect(outOfScopeFiles(files, ['web/**', 'tests/**'])).toEqual([
      'src/main/index.ts',
      'README.md'
    ])
  })

  test('empty scope allows every file', () => {
    expect(outOfScopeFiles(['src/main/index.ts', 'README.md'], [])).toEqual([])
  })

  test('dot files are matched when the pattern allows them', () => {
    expect(outOfScopeFiles(['.github/notes.md', 'docs/readme.md'], ['**/*.md'])).toEqual([])
  })
})
