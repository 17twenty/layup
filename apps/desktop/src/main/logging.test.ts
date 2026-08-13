import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, isForbiddenKey, newCorrelationId } from './logging';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    base: { component: 'main' },
    write: (line) => lines.push(line),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line)) };
}

describe('main process logging', () => {
  it('emits one machine-parseable object per line', () => {
    const { logger, records } = capture();
    logger.info('capture started', { sourceId: 'screen:1', displayCount: 2 });
    expect(records()[0]).toEqual({
      time: '2026-01-01T00:00:00.000Z',
      level: 'INFO',
      msg: 'capture started',
      component: 'main',
      sourceId: 'screen:1',
      displayCount: 2,
    });
  });

  it('attaches correlation fields through child loggers', () => {
    const { logger, records } = capture();
    const sessionLog = logger.with({ sessionId: 'sess-1' }).with({ layupId: 'l1' });
    sessionLog.warn('ice restart');
    expect(records()[0]).toMatchObject({ sessionId: 'sess-1', layupId: 'l1', component: 'main' });
  });

  it('redacts content and credentials, including nested fields', () => {
    const { logger, lines, records } = capture();
    logger.error('input rejected', {
      keystrokes: 'rm -rf /',
      clipboard: 'secret plan',
      cursorX: 0.42,
      turn: { password: 'hunter2', realm: 'layup' },
      layupId: 'l1',
    });
    const record = records()[0];
    expect(record.keystrokes).toBe(REDACTED);
    expect(record.clipboard).toBe(REDACTED);
    expect(record.cursorX).toBe(REDACTED);
    expect(record.turn).toEqual({ password: REDACTED, realm: 'layup' });
    expect(record.layupId).toBe('l1');
    expect(lines.join('\n')).not.toMatch(/hunter2|rm -rf|secret plan/);
  });

  it('classifies field names regardless of case and separators', () => {
    for (const key of ['API_KEY', 'api-key', 'Turn.Password', 'TypedText', 'screenshot']) {
      expect(isForbiddenKey(key)).toBe(true);
    }
    for (const key of ['layupId', 'membershipId', 'durationMs', 'iceCandidateType']) {
      expect(isForbiddenKey(key)).toBe(false);
    }
  });

  it('honours the level threshold', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });
    logger.debug('noisy');
    logger.info('chatty');
    logger.warn('worth knowing');
    expect(lines).toHaveLength(1);
  });

  it('generates distinct correlation ids', () => {
    expect(newCorrelationId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});
