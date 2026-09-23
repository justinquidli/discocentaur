// pm2 config. kill_timeout must exceed SHUTDOWN_GRACE_MS (10 s, shutdown.js):
// pm2's default of 1.6 s SIGKILLs the bot before an in-flight drop can finish.
// One-time switch from a CLI-started process:
//   pm2 delete claudetaur && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [{
    name: 'claudetaur',
    script: 'bot.js',
    cwd: __dirname,
    kill_timeout: 15000,
  }],
};
