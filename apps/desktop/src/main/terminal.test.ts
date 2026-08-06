import { describe, expect, it } from 'vitest';

import { authoringEnv } from './terminal.js';

/**
 * Both things this scrubs are invisible when they go wrong. A leaked provider
 * key bills the wrong account; a leaked session marker silently stops the
 * transcript. In both cases the terminal looks entirely normal.
 */
describe('the environment an authoring session gets', () => {
  const ambient = {
    HOME: '/Users/someone',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    PATH: '/inherited/bin',
    // A provider key, exported for something else entirely.
    ANTHROPIC_API_KEY: 'sk-ant-real',
    OPENAI_API_KEY: 'sk-openai-real',
    // The identity of the session Studio was launched from.
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: 'true',
    CLAUDE_CODE_SESSION_ID: '7c2598d6',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_EXECPATH: '/opt/claude',
    CLAUDE_PID: '4242',
    CLAUDE_EFFORT: 'high',
    // A setting the user deliberately exported. Theirs, not a leak.
    CLAUDE_CONFIG_DIR: '/Users/someone/.config/claude',
  };

  it('passes the ordinary environment through', () => {
    const env = authoringEnv(ambient, '/login/bin');
    expect(env.HOME).toBe('/Users/someone');
    expect(env.SHELL).toBe('/bin/zsh');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
  });

  it('uses the login PATH, not the inherited one', () => {
    // A GUI app's PATH is minimal, which is how `claude` came back "not
    // installed" while it was visibly running in another window.
    expect(authoringEnv(ambient, '/login/bin').PATH).toBe('/login/bin');
  });

  it('withholds provider keys', () => {
    // Authoring is the user's own subscription. With a key exported, Claude
    // Code silently bills it instead — and the automation's run budget pays for
    // the conversation that wrote it.
    const env = authoringEnv(ambient, '/login/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('withholds another session’s identity', () => {
    // The symptom this fixes: "Transcript saving is off — inherited
    // CLAUDE_CODE_CHILD_SESSION marker". The new session concluded it was a
    // subprocess of the one that launched Studio, and stopped keeping history.
    const env = authoringEnv(ambient, '/login/bin');
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
    ]) {
      expect(env[key], `${key} must not be inherited`).toBeUndefined();
    }
  });

  it('keeps configuration the user set themselves', () => {
    // The line between "another session's state" and "this person's setting".
    // Dropping the latter would silently ignore a config directory they chose.
    expect(authoringEnv(ambient, '/login/bin').CLAUDE_CONFIG_DIR).toBe(
      '/Users/someone/.config/claude',
    );
  });

  it('scrubs nothing that is not there', () => {
    const env = authoringEnv({ HOME: '/h' }, '/p');
    expect(env).toEqual({ HOME: '/h', PATH: '/p', TERM: 'xterm-256color' });
  });
});
