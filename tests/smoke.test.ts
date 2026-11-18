import { expect, test } from 'vitest'
import { APP_NAME } from '../src/shared/constants'

test('app name', () => { expect(APP_NAME).toBe('AgentGroup') })
