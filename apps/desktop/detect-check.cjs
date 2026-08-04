const { app } = require('electron');
app.whenReady().then(async () => {
  // Simulate the GUI PATH a double-clicked .app gets.
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const { TerminalHost } = await import('/Users/shaharcohen/Desktop/claritty/clarity-studio/apps/desktop/dist/main/terminal.js');
  const { detectAgents } = await import('/Users/shaharcohen/Desktop/claritty/clarity-studio/node_modules/@clarity-studio/agent-bridge/dist/index.js');
  const host = new TerminalHost();
  const found = await detectAgents(host.probe);
  console.log('minimal PATH:', process.env.PATH);
  console.log('agents found:', found.map((a) => `${a.name} ${a.version}`).join(', ') || 'NONE');
  app.exit(found.length ? 0 : 1);
});
