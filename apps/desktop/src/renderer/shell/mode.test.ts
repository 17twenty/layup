import { describe, expect, it } from 'vitest';
import { nextMode } from './mode';

const idle = { inLayup: false, pickerOpen: false, hasIncomingScreen: false };

describe('which shape the window should be', () => {
  it('is the directory when you are not in a layup', () => {
    expect(nextMode(idle)).toBe('home');
    // Even mid-picker: there is nothing to share into.
    expect(nextMode({ ...idle, pickerOpen: true })).toBe('home');
  });

  it('is small whenever there is no reason to be big', () => {
    expect(nextMode({ ...idle, inLayup: true })).toBe('compact');
  });

  it('grows to watch somebody, and only once their screen has arrived', () => {
    expect(nextMode({ inLayup: true, pickerOpen: false, hasIncomingScreen: true })).toBe('viewer');
  });

  it('lets choosing beat watching', () => {
    // Switching source while somebody presents must not fight itself.
    expect(nextMode({ inLayup: true, pickerOpen: true, hasIncomingScreen: true })).toBe('picker');
  });

  it('stays small while you are the one sharing', () => {
    // Presenting is not a reason to grow: you are looking at your own screen,
    // and the border around it is the indicator. Nothing about this input says
    // "presenting" - which is the point.
    expect(nextMode({ inLayup: true, pickerOpen: false, hasIncomingScreen: false })).toBe('compact');
  });
});
